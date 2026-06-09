const cron     = require('node-cron');
const { supabase } = require('../db/supabase');
const { todayMSK } = require('../utils/time');

const TZ = 'Europe/Moscow'; // UTC+3, no DST

// ── DB helpers ──────────────────────────────────────────────────────────────

async function getActiveUsers() {
  const { data, error } = await supabase
    .from('users')
    .select('telegram_id, first_name, daily_calories, daily_protein_g, daily_fat_g, daily_carbs_g')
    .eq('onboarding_complete', true);
  if (error) console.error('[scheduler] getActiveUsers:', error.message);
  return data ?? [];
}

// ── Safe send ───────────────────────────────────────────────────────────────
// Swallows 403 (user blocked bot) and 400 (chat not found) silently.
async function send(bot, telegramId, text) {
  try {
    await bot.telegram.sendMessage(telegramId, text, { parse_mode: 'HTML' });
  } catch (err) {
    const known = ['403', '400', 'chat not found', 'bot was blocked'];
    const isKnown = known.some(s => err.message?.includes(s));
    if (!isKnown) {
      console.error(`[scheduler] sendMessage → ${telegramId}:`, err.message);
    }
  }
}

// ── JOB 1 — Morning Brief — 09:00 MSK ──────────────────────────────────────

async function morningBrief(bot) {
  const users = await getActiveUsers();
  console.log(`[scheduler/morning] → ${users.length} user(s)`);

  for (const u of users) {
    const greeting = u.first_name ? `Доброе утро, ${u.first_name}.` : 'Доброе утро.';
    await send(bot, u.telegram_id,
      `⚡️ <b>УТРЕННИЙ БРИФИНГ</b>\n\n` +
      `${greeting} Норма на сегодня:\n\n` +
      `🔥 Калории:  <b>${u.daily_calories}</b> ккал\n` +
      `🥩 Белки:    <b>${u.daily_protein_g}</b> г\n` +
      `🧈 Жиры:     <b>${u.daily_fat_g}</b> г\n` +
      `🍞 Углеводы: <b>${u.daily_carbs_g}</b> г\n\n` +
      `Система ждёт данных. Жду первый лог.`
    );
  }
}

// ── JOB 2 — Inactivity Trigger — 16:00 & 20:00 MSK ─────────────────────────
// Two queries: all active users + all telegram_ids that logged today (MSK).
// Cross-reference in JS — no N+1 queries.

async function inactivityCheck(bot) {
  const today = todayMSK();

  const [users, logsResult] = await Promise.all([
    getActiveUsers(),
    supabase.from('food_logs').select('telegram_id').eq('log_date', today),
  ]);

  if (logsResult.error) {
    console.error('[scheduler/inactivity] DB error:', logsResult.error.message);
    return;
  }

  const loggedIds = new Set((logsResult.data ?? []).map(r => r.telegram_id));
  const silent    = users.filter(u => !loggedIds.has(u.telegram_id));

  console.log(`[scheduler/inactivity] → ${silent.length} silent user(s) of ${users.length}`);

  for (const u of silent) {
    await send(bot, u.telegram_id,
      `🔴 <b>ТРИГГЕР НЕАКТИВНОСТИ</b>\n\n` +
      `Система не обнаружила входящих данных за сегодня.\n\n` +
      `Забыл поесть — или забыл записать?\n` +
      `Жду апдейт. Отправь фото или напиши название блюда.`
    );
  }
}

// ── JOB 3 — Streak Reminder — 21:00 MSK ────────────────────────────────────
// Uses last_log_date from users table (set by updateStreak on every commit).
// Only pings users who haven't logged anything today — one message, no repeat.

function ruDays(n) {
  const m10 = n % 10, m100 = n % 100;
  if (m100 >= 11 && m100 <= 19) return 'дней';
  if (m10 === 1) return 'день';
  if (m10 >= 2 && m10 <= 4) return 'дня';
  return 'дней';
}

async function streakReminder(bot) {
  const today = todayMSK();

  const { data: users, error } = await supabase
    .from('users')
    .select('telegram_id, first_name, current_streak, last_log_date')
    .eq('onboarding_complete', true);

  if (error) {
    console.error('[scheduler/streak-reminder] DB error:', error.message);
    return;
  }

  const silent = (users ?? []).filter(u => {
    const d = u.last_log_date ? String(u.last_log_date).slice(0, 10) : null;
    return d !== today;
  });

  console.log(`[scheduler/streak-reminder] → ${silent.length} silent user(s) of ${(users ?? []).length}`);

  for (const u of silent) {
    const name   = u.first_name ? `, ${u.first_name}` : '';
    const streak = u.current_streak || 0;

    const text = streak > 0
      ? `Эй${name}, кажется, ты сегодня забыл записать еду 🍽\n\n` +
        `Стрик ${streak} ${ruDays(streak)} сгорит в полночь, если не залогируешь хотя бы один приём. ` +
        `Давай быстро закинем, пока не поздно 🔥`
      : `Эй${name}, кажется, ты сегодня забыл записать еду 🍽\n\n` +
        `Давай быстро занесём что-нибудь — отправь фото или напиши название блюда.`;

    await send(bot, u.telegram_id, text);
  }
}

// ── JOB 4 — Evening Summary — 23:00 MSK ────────────────────────────────────
// One query for all today's logs → aggregate in JS → one message per user.

async function eveningSummary(bot) {
  const today = todayMSK();

  const [users, logsResult] = await Promise.all([
    getActiveUsers(),
    supabase
      .from('food_logs')
      .select('telegram_id, calories, protein_g, fat_g, carbs_g')
      .eq('log_date', today),
  ]);

  if (logsResult.error) {
    console.error('[scheduler/evening] DB error:', logsResult.error.message);
    return;
  }

  const totals = {};
  for (const row of logsResult.data ?? []) {
    const id = row.telegram_id;
    if (!totals[id]) totals[id] = { cal: 0, pro: 0, fat: 0, car: 0, count: 0 };
    totals[id].cal   += row.calories             || 0;
    totals[id].pro   += parseFloat(row.protein_g || 0);
    totals[id].fat   += parseFloat(row.fat_g     || 0);
    totals[id].car   += parseFloat(row.carbs_g   || 0);
    totals[id].count += 1;
  }

  console.log(`[scheduler/evening] → ${users.length} user(s)`);

  for (const u of users) {
    const t = totals[u.telegram_id];

    if (!t || t.cal === 0) {
      await send(bot, u.telegram_id,
        `📋 <b>ИТОГОВЫЙ ОТЧЁТ — ${today}</b>\n\n` +
        `Данных за сегодня нет.\n` +
        `<b>Нулевой день зафиксирован.</b>`
      );
      continue;
    }

    const pct    = Math.round(t.cal / (u.daily_calories || 1) * 100);
    const remain = u.daily_calories - t.cal;
    const status =
      pct >= 110 ? '🔴 Превышение нормы' :
      pct >= 95  ? '🟢 Норма выполнена'  :
      pct >= 70  ? '🟡 Лёгкий недобор'   :
                   '⚪️ Критически мало';

    await send(bot, u.telegram_id,
      `📋 <b>ИТОГОВЫЙ ОТЧЁТ — ${today}</b>\n\n` +
      `Приёмов пищи: <b>${t.count}</b>\n\n` +
      `🔥 Калории:  <b>${t.cal}</b> / ${u.daily_calories} ккал\n` +
      `🥩 Белки:    <b>${Math.round(t.pro)}</b> / ${u.daily_protein_g} г\n` +
      `🧈 Жиры:     <b>${Math.round(t.fat)}</b> / ${u.daily_fat_g} г\n` +
      `🍞 Углеводы: <b>${Math.round(t.car)}</b> / ${u.daily_carbs_g} г\n\n` +
      `Эффективность: <b>${pct}%</b> — ${status}\n` +
      (remain > 0
        ? `Недобор: <b>${remain}</b> ккал`
        : `Превышение: <b>${Math.abs(remain)}</b> ккал`)
    );
  }
}

// ── Init ────────────────────────────────────────────────────────────────────

function initScheduler(bot) {
  const opts = { timezone: TZ };

  cron.schedule('0 9     * * *', () => morningBrief(bot),    opts); // 09:00 MSK
  cron.schedule('0 16,20 * * *', () => inactivityCheck(bot), opts); // 16:00 & 20:00 MSK
  cron.schedule('0 21    * * *', () => streakReminder(bot),  opts); // 21:00 MSK
  cron.schedule('0 23    * * *', () => eveningSummary(bot),  opts); // 23:00 MSK

  console.log(`✅ Scheduler running (TZ: ${TZ}) — jobs: 09:00 / 16:00 / 20:00 / 21:00 / 23:00 MSK`);
}

module.exports = { initScheduler };
