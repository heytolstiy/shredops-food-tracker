const { supabase } = require('../db/supabase');
const { todayMSK, daysAgoMSK } = require('../utils/time');

const MEAL_LABEL = { breakfast: 'завтрак', lunch: 'обед', dinner: 'ужин', snack: 'перекус' };
const RU_DOW = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];

function fmtDow(ymd) {
  return RU_DOW[new Date(`${ymd}T00:00:00Z`).getUTCDay()];
}

// logged_at is a TIMESTAMPTZ (UTC) — shift +3h and read UTC getters to print
// MSK wall-clock time, same trick as todayMSK()/nowMSK().
function fmtTimeMSK(iso) {
  const d = new Date(new Date(iso).getTime() + 3 * 60 * 60 * 1000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

function indexByDate(rows, key) {
  const map = {};
  for (const row of rows) map[row.log_date] = key ? row[key] : row;
  return map;
}

// Builds a plain-text/Markdown weekly report (last 7 calendar days, MSK,
// today inclusive) for one user. Shared by the /week bot command and the
// GET /api/export/week/:userId endpoint — one generator, not two.
//
// This is meant to be read by an external dietitian/trainer, not just the
// user — so it deliberately includes the full per-meal log, not only daily
// totals. Days with no data are marked explicitly ("нет данных"), never
// silently zeroed.
async function generateWeeklyReport(telegramId) {
  const today = todayMSK();
  const startDate = daysAgoMSK(6);
  const dates = Array.from({ length: 7 }, (_, i) => daysAgoMSK(6 - i)); // oldest → newest

  const [userResult, logsResult, targetsResult, weightResult, stepsResult, waterResult, workoutResult] = await Promise.all([
    supabase
      .from('users')
      .select('first_name, username, daily_calories, daily_protein_g, daily_fat_g, daily_carbs_g')
      .eq('telegram_id', telegramId)
      .maybeSingle(),
    supabase
      .from('food_logs')
      .select('log_date, logged_at, description, calories, protein_g, fat_g, carbs_g, meal_type, raw_ai_response')
      .eq('telegram_id', telegramId)
      .gte('log_date', startDate)
      .lte('log_date', today)
      .order('logged_at', { ascending: true }),
    supabase
      .from('daily_targets')
      .select('log_date, calories, protein_g, fat_g, carbs_g')
      .eq('telegram_id', telegramId)
      .gte('log_date', startDate)
      .lte('log_date', today),
    supabase
      .from('weight_logs')
      .select('log_date, weight_kg')
      .eq('telegram_id', telegramId)
      .gte('log_date', startDate)
      .lte('log_date', today),
    supabase
      .from('steps_logs')
      .select('log_date, steps')
      .eq('telegram_id', telegramId)
      .gte('log_date', startDate)
      .lte('log_date', today),
    supabase
      .from('water_logs')
      .select('log_date, amount_ml')
      .eq('telegram_id', telegramId)
      .gte('log_date', startDate)
      .lte('log_date', today),
    supabase
      .from('workout_logs')
      .select('log_date, description')
      .eq('telegram_id', telegramId)
      .gte('log_date', startDate)
      .lte('log_date', today),
  ]);

  if (!userResult.data) return null;

  for (const [label, r] of [
    ['food_logs', logsResult], ['daily_targets', targetsResult], ['weight_logs', weightResult],
    ['steps_logs', stepsResult], ['water_logs', waterResult], ['workout_logs', workoutResult],
  ]) {
    if (r.error) console.error(`[export] ${label} query error:`, r.error.message);
  }

  const user = userResult.data;
  const logsByDate    = {};
  for (const row of logsResult.data ?? []) (logsByDate[row.log_date] ??= []).push(row);
  const targetsByDate = indexByDate(targetsResult.data ?? []);
  const weightByDate  = indexByDate(weightResult.data ?? [], 'weight_kg');
  const stepsByDate   = indexByDate(stepsResult.data ?? [], 'steps');
  const workoutByDate = indexByDate(workoutResult.data ?? [], 'description');

  const waterByDate = {};
  for (const row of waterResult.data ?? []) {
    waterByDate[row.log_date] = (waterByDate[row.log_date] || 0) + (row.amount_ml || 0);
  }

  const lines = [];
  lines.push(`# Отчёт за неделю — ${startDate} – ${today}`);
  lines.push('');
  lines.push(`Пользователь: ${[user.first_name, user.username ? `@${user.username}` : null].filter(Boolean).join(' ')}`);
  lines.push('');
  lines.push('## По дням');

  let calSum = 0, proSum = 0, fatSum = 0, carSum = 0, daysWithFood = 0, daysHitTarget = 0;
  let stepsSum = 0, stepsCount = 0, waterSum = 0, waterCount = 0, workoutDays = 0;
  const weighIns = [];

  for (const date of dates) {
    const dayLogs = logsByDate[date] ?? [];
    // Historical target = the frozen snapshot for that day if it exists,
    // else the live profile (matches the fallback in /api/logs/:userId/:date).
    const target = targetsByDate[date] ?? {
      calories: user.daily_calories, protein_g: user.daily_protein_g,
      fat_g: user.daily_fat_g, carbs_g: user.daily_carbs_g,
    };

    lines.push('');
    lines.push(`### ${fmtDow(date)}, ${date}`);

    if (dayLogs.length === 0) {
      lines.push('Приёмов пищи не было. Нет данных.');
    } else {
      const dayTotals = dayLogs.reduce((a, r) => ({
        cal: a.cal + (r.calories || 0),
        pro: a.pro + parseFloat(r.protein_g || 0),
        fat: a.fat + parseFloat(r.fat_g || 0),
        car: a.car + parseFloat(r.carbs_g || 0),
      }), { cal: 0, pro: 0, fat: 0, car: 0 });

      const pct = target.calories > 0 ? Math.round((dayTotals.cal / target.calories) * 100) : 0;

      lines.push(`Калории: ${Math.round(dayTotals.cal)} / ${target.calories} ккал (${pct}%)`);
      lines.push(`Белки: ${Math.round(dayTotals.pro)} / ${target.protein_g} г`);
      lines.push(`Жиры: ${Math.round(dayTotals.fat)} / ${target.fat_g} г`);
      lines.push(`Углеводы: ${Math.round(dayTotals.car)} / ${target.carbs_g} г`);
      lines.push('');
      lines.push('Приёмы пищи:');
      for (const r of dayLogs) {
        const name = r.raw_ai_response?.identified_food || r.description;
        const meal = MEAL_LABEL[r.meal_type] || r.meal_type;
        lines.push(
          `- ${fmtTimeMSK(r.logged_at)} [${meal}] ${name} — ${r.calories} ккал, ` +
          `Б${Math.round(r.protein_g)} Ж${Math.round(r.fat_g)} У${Math.round(r.carbs_g)}`
        );
      }

      calSum += dayTotals.cal; proSum += dayTotals.pro; fatSum += dayTotals.fat; carSum += dayTotals.car;
      daysWithFood++;
      if (pct >= 95 && pct <= 110) daysHitTarget++;
    }

    const waterMl = waterByDate[date];
    lines.push(`Вода: ${waterMl != null ? `${waterMl} мл` : 'нет данных'}`);
    if (waterMl != null) { waterSum += waterMl; waterCount++; }

    const weightKg = weightByDate[date];
    lines.push(`Вес: ${weightKg != null ? `${weightKg} кг` : 'нет данных'}`);
    if (weightKg != null) weighIns.push(weightKg);

    const steps = stepsByDate[date];
    lines.push(`Шаги: ${steps != null ? steps : 'нет данных'}`);
    if (steps != null) { stepsSum += steps; stepsCount++; }

    const workout = workoutByDate[date];
    lines.push(`Тренировка: ${workout || 'не было'}`);
    if (workout) workoutDays++;
  }

  lines.push('');
  lines.push('## Итоги за неделю');
  lines.push('');

  if (daysWithFood > 0) {
    lines.push(`Среднее калорий: ${Math.round(calSum / daysWithFood)} ккал/день`);
    lines.push(`Среднее белков: ${Math.round(proSum / daysWithFood)} г/день`);
    lines.push(`Среднее жиров: ${Math.round(fatSum / daysWithFood)} г/день`);
    lines.push(`Среднее углеводов: ${Math.round(carSum / daysWithFood)} г/день`);
    lines.push(`Дней с выполненной нормой калорий (95–110%): ${daysHitTarget} из ${daysWithFood} дней с данными`);
  } else {
    lines.push('Питание: нет данных за эту неделю.');
  }

  if (weighIns.length > 0) {
    const first = weighIns[0], last = weighIns[weighIns.length - 1];
    const delta = Math.round((last - first) * 10) / 10;
    lines.push(
      `Вес: ${first} → ${last} кг (${delta >= 0 ? '+' : ''}${delta}), ` +
      `мин ${Math.min(...weighIns)} / макс ${Math.max(...weighIns)}`
    );
  } else {
    lines.push('Вес: нет данных за неделю.');
  }

  lines.push(stepsCount > 0
    ? `Шаги: среднее ${Math.round(stepsSum / stepsCount)} в день (${stepsCount} из 7 дней с данными)`
    : 'Шаги: нет данных за неделю.');

  lines.push(waterCount > 0
    ? `Вода: среднее ${Math.round(waterSum / waterCount)} мл/день (${waterCount} из 7 дней с данными)`
    : 'Вода: нет данных за неделю.');

  lines.push(`Тренировок за неделю: ${workoutDays} из 7 дней`);

  return {
    content:  lines.join('\n') + '\n',
    filename: `report-${startDate}_${today}.md`,
  };
}

module.exports = { generateWeeklyReport };
