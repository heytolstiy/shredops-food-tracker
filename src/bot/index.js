const { Telegraf, Scenes, session, Markup } = require('telegraf');
const { onboardingScene } = require('./scenes/onboarding');
const {
  handleFoodPhoto,
  handleFoodText,
  handleManualEntry,
  handleConfirmLog,
  handleCancelLog,
  handleCorrectionText,
} = require('./handlers/food');
const { supabase }   = require('../db/supabase');
const { todayMSK }   = require('../utils/time');
const { generateWeeklyReport } = require('../services/export');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// ── Supabase-backed session store ──────────────────────────────────────────
// Persists session across bot restarts so pendingLog (food preview) survives
// Railway deploys and the user can still send corrections after a restart.

const sessionStore = {
  async get(key) {
    const { data } = await supabase
      .from('bot_sessions')
      .select('session_data')
      .eq('session_key', key)
      .maybeSingle();
    return data?.session_data ?? undefined;
  },
  async set(key, val) {
    await supabase
      .from('bot_sessions')
      .upsert(
        { session_key: key, session_data: val, updated_at: new Date().toISOString() },
        { onConflict: 'session_key' },
      );
  },
  async delete(key) {
    await supabase.from('bot_sessions').delete().eq('session_key', key);
  },
};

// ── middleware ─────────────────────────────────────────────────────────────

const stage = new Scenes.Stage([onboardingScene]);
bot.use(session({ store: sessionStore }));
bot.use(stage.middleware());

// ── global error handler ───────────────────────────────────────────────────

bot.catch((err, ctx) => {
  console.error(`[bot] Unhandled error (${ctx.updateType}):`, err.message ?? err);
});

// ── /start ─────────────────────────────────────────────────────────────────

bot.command('start', async (ctx) => {
  const { data: user, error } = await supabase
    .from('users')
    .select('onboarding_complete, first_name, daily_calories, daily_protein_g, daily_fat_g, daily_carbs_g')
    .eq('telegram_id', ctx.from.id)
    .maybeSingle();

  if (error) {
    console.error('[/start] DB error:', error.message);
    return ctx.reply('Что-то пошло не так. Попробуй ещё раз.');
  }

  if (user?.onboarding_complete) {
    return ctx.reply(
      `👋 С возвращением, ${user.first_name ?? 'друг'}!\n\n` +
      `📊 Твои дневные нормы:\n` +
      `🔥 Калории: ${user.daily_calories} ккал\n` +
      `🥩 Белки:   ${user.daily_protein_g} г\n` +
      `🧈 Жиры:    ${user.daily_fat_g} г\n` +
      `🍞 Углеводы: ${user.daily_carbs_g} г\n\n` +
      `Отправь 📷 фото еды с подписью (вес и состав), чтобы занести приём пищи.\n\n` +
      `Команды:\n` +
      `/today — прогресс за день\n` +
      `/weight — записать/посмотреть вес\n` +
      `/steps — записать/посмотреть шаги\n` +
      `/targets — изменить цели по КБЖУ\n` +
      `/week — отчёт за 7 дней (.md-файл)\n` +
      `/dashboard — открыть статистику\n` +
      `/profile — твои данные\n` +
      `/reset — заполнить анкету заново`
    );
  }

  return ctx.scene.enter('onboarding');
});

// ── /profile — read-only profile summary ──────────────────────────────────

const ACTIVITY_LABEL = {
  sedentary:   'Сидячий (×1.2)',
  light:       'Лёгкая (×1.375)',
  moderate:    'Умеренная (×1.55)',
  active:      'Высокая (×1.725)',
  very_active: 'Очень высокая (×1.9)',
};
const GOAL_LABEL = {
  lose:     'Сушка (−20%)',
  maintain: 'Поддержание',
  gain:     'Масса (+20%)',
};
const GENDER_LABEL = { male: 'Мужской', female: 'Женский' };

bot.command(['profile', 'профиль'], async (ctx) => {
  const { data: user, error } = await supabase
    .from('users')
    .select('gender, age, weight_kg, height_cm, activity_level, goal, daily_calories, daily_protein_g, daily_fat_g, daily_carbs_g, target_water_ml')
    .eq('telegram_id', ctx.from.id)
    .maybeSingle();

  if (error) {
    console.error('[/profile] DB error:', error.message);
    return ctx.reply('Что-то пошло не так. Попробуй ещё раз.');
  }

  if (!user) {
    return ctx.reply('Профиль не найден. Используй /start чтобы создать его.');
  }

  return ctx.reply(
    `👤 <b>ПРОФИЛЬ</b>\n\n` +
    `Пол:        ${GENDER_LABEL[user.gender] ?? user.gender}\n` +
    `Возраст:    ${user.age} лет\n` +
    `Вес:        ${user.weight_kg} кг\n` +
    `Рост:       ${user.height_cm} см\n` +
    `Активность: ${ACTIVITY_LABEL[user.activity_level] ?? user.activity_level}\n` +
    `Цель:       ${GOAL_LABEL[user.goal] ?? user.goal}\n\n` +
    `📊 <b>Дневная программа:</b>\n` +
    `🔥 Калории:  <b>${user.daily_calories}</b> ккал\n` +
    `🥩 Белки:    <b>${user.daily_protein_g}</b> г\n` +
    `🧈 Жиры:     <b>${user.daily_fat_g}</b> г\n` +
    `🍞 Углеводы: <b>${user.daily_carbs_g}</b> г\n\n` +
    `💧 Норма воды: <b>${user.target_water_ml ?? 2500}</b> мл\n\n` +
    `💡 Чтобы изменить эти параметры и пройти опрос заново, используй команду /reset`,
    { parse_mode: 'HTML' }
  );
});

// ── /weight — editable daily weigh-in ──────────────────────────────────────
// One value per day: re-recording the same day overwrites via upsert on
// (telegram_id, log_date), it never duplicates. Keeps users.weight_kg in
// sync so /profile always reflects the latest weigh-in, not the onboarding
// value.
//
// Command name is ASCII ("weight") on purpose — Telegram's BotCommand spec
// only allows lowercase Latin letters/digits/underscores, and Cyrillic slash
// commands aren't reliably recognised as bot_command entities even when
// typed manually. The "вес" trigger below is kept as a harmless fallback,
// but never advertise it as the primary way to call this.

function parseWeightArg(text) {
  const parts = text.trim().split(/\s+/);
  return parts.length > 1 ? parts.slice(1).join(' ') : null;
}

bot.command(['weight', 'вес'], async (ctx) => {
  const telegramId = ctx.from.id;
  const arg = parseWeightArg(ctx.message.text);

  const { data: user, error: userError } = await supabase
    .from('users')
    .select('weight_kg, onboarding_complete')
    .eq('telegram_id', telegramId)
    .maybeSingle();

  if (userError) {
    console.error('[/weight] user query error:', userError.message);
    return ctx.reply('Что-то пошло не так. Попробуй ещё раз.');
  }

  if (!user?.onboarding_complete) {
    return ctx.reply('Сначала заполни анкету — используй /start.');
  }

  // No argument — show the last recorded weight
  if (!arg) {
    const { data: last, error } = await supabase
      .from('weight_logs')
      .select('weight_kg, log_date')
      .eq('telegram_id', telegramId)
      .order('log_date', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error('[/weight] last-entry query error:', error.message);
      return ctx.reply('Не удалось загрузить данные. Попробуй ещё раз.');
    }

    if (!last) {
      return ctx.reply(
        `⚖️ Записей веса пока нет. Из анкеты: <b>${user.weight_kg}</b> кг.\n\n` +
        `Чтобы записать текущий вес: <code>/weight 82.5</code>`,
        { parse_mode: 'HTML' }
      );
    }

    return ctx.reply(
      `⚖️ Последняя запись: <b>${last.weight_kg}</b> кг — ${last.log_date}\n\n` +
      `Обновить: <code>/weight 82.5</code>`,
      { parse_mode: 'HTML' }
    );
  }

  // Argument given — validate and upsert today's entry
  const weightKg = parseFloat(arg.replace(',', '.'));
  if (isNaN(weightKg) || weightKg < 20 || weightKg > 300) {
    return ctx.reply('⚠️ Введи вес числом от 20 до 300 кг. Пример: <code>/weight 82.5</code>', { parse_mode: 'HTML' });
  }

  const today = todayMSK();

  const { error: upsertError } = await supabase
    .from('weight_logs')
    .upsert(
      { telegram_id: telegramId, log_date: today, weight_kg: weightKg, logged_at: new Date().toISOString() },
      { onConflict: 'telegram_id,log_date' }
    );

  if (upsertError) {
    console.error('[/weight] upsert error:', upsertError.message);
    return ctx.reply('❌ Не удалось сохранить вес. Попробуй ещё раз.');
  }

  const { error: usersUpdateError } = await supabase
    .from('users')
    .update({ weight_kg: weightKg, updated_at: new Date().toISOString() })
    .eq('telegram_id', telegramId);

  if (usersUpdateError) {
    console.error('[/weight] users update error:', usersUpdateError.message);
  }

  return ctx.reply(`✅ Вес записан: <b>${weightKg}</b> кг — ${today}`, { parse_mode: 'HTML' });
});

// ── /steps — editable daily step count ─────────────────────────────────────
// Same overwrite-on-re-entry semantics as /weight: one value per day, upsert
// on (telegram_id, log_date), never additive (unlike water).

function parseStepsArg(text) {
  const parts = text.trim().split(/\s+/);
  return parts.length > 1 ? parts.slice(1).join(' ') : null;
}

bot.command(['steps', 'шаги'], async (ctx) => {
  const telegramId = ctx.from.id;
  const arg = parseStepsArg(ctx.message.text);

  const { data: user, error: userError } = await supabase
    .from('users')
    .select('onboarding_complete')
    .eq('telegram_id', telegramId)
    .maybeSingle();

  if (userError) {
    console.error('[/steps] user query error:', userError.message);
    return ctx.reply('Что-то пошло не так. Попробуй ещё раз.');
  }

  if (!user?.onboarding_complete) {
    return ctx.reply('Сначала заполни анкету — используй /start.');
  }

  // No argument — show today's recorded steps
  if (!arg) {
    const today = todayMSK();

    const { data: todayEntry, error } = await supabase
      .from('steps_logs')
      .select('steps')
      .eq('telegram_id', telegramId)
      .eq('log_date', today)
      .maybeSingle();

    if (error) {
      console.error('[/steps] today-entry query error:', error.message);
      return ctx.reply('Не удалось загрузить данные. Попробуй ещё раз.');
    }

    if (!todayEntry) {
      return ctx.reply(
        `👟 Шаги за сегодня не записаны.\n\n` +
        `Чтобы записать: <code>/steps 8500</code>`,
        { parse_mode: 'HTML' }
      );
    }

    return ctx.reply(
      `👟 Сегодня: <b>${todayEntry.steps}</b> шагов.\n\n` +
      `Обновить: <code>/steps 8500</code>`,
      { parse_mode: 'HTML' }
    );
  }

  // Argument given — validate and upsert today's entry
  const steps = Math.round(Number(arg.replace(',', '.')));
  if (isNaN(steps) || steps < 0 || steps > 200000) {
    return ctx.reply('⚠️ Введи шаги числом от 0 до 200000. Пример: <code>/steps 8500</code>', { parse_mode: 'HTML' });
  }

  const today = todayMSK();

  const { error: upsertError } = await supabase
    .from('steps_logs')
    .upsert(
      { telegram_id: telegramId, log_date: today, steps, logged_at: new Date().toISOString() },
      { onConflict: 'telegram_id,log_date' }
    );

  if (upsertError) {
    console.error('[/steps] upsert error:', upsertError.message);
    return ctx.reply('❌ Не удалось сохранить шаги. Попробуй ещё раз.');
  }

  return ctx.reply(`✅ Шаги записаны: <b>${steps}</b> — ${today}`, { parse_mode: 'HTML' });
});

// ── /targets — manual daily calorie/macro correction ───────────────────────
// Direct override of users.daily_calories/daily_protein_g/daily_fat_g/
// daily_carbs_g — bypasses calculateTDEE/calculateMacros entirely. This is
// the user taking manual control, not a recalculation. Unlike /reset (full
// 8-step onboarding wizard), this touches only the four target numbers.

function parseTargetsArgs(text) {
  const parts = text.trim().split(/\s+/).slice(1);
  return parts.length === 4 ? parts : null;
}

bot.command('targets', async (ctx) => {
  const telegramId = ctx.from.id;
  const args = parseTargetsArgs(ctx.message.text);

  const { data: user, error: userError } = await supabase
    .from('users')
    .select('daily_calories, daily_protein_g, daily_fat_g, daily_carbs_g, onboarding_complete')
    .eq('telegram_id', telegramId)
    .maybeSingle();

  if (userError) {
    console.error('[/targets] user query error:', userError.message);
    return ctx.reply('Что-то пошло не так. Попробуй ещё раз.');
  }

  if (!user?.onboarding_complete) {
    return ctx.reply('Сначала заполни анкету — используй /start.');
  }

  // No arguments — show current targets
  if (!args) {
    return ctx.reply(
      `📊 <b>Текущие цели:</b>\n\n` +
      `🔥 Калории:  <b>${user.daily_calories}</b> ккал\n` +
      `🥩 Белки:    <b>${user.daily_protein_g}</b> г\n` +
      `🧈 Жиры:     <b>${user.daily_fat_g}</b> г\n` +
      `🍞 Углеводы: <b>${user.daily_carbs_g}</b> г\n\n` +
      `Изменить: <code>/targets 2000 175 70 180</code>\n` +
      `(порядок: калории, белки, жиры, углеводы)`,
      { parse_mode: 'HTML' }
    );
  }

  const nums = args.map(s => Math.round(Number(s.replace(',', '.'))));
  const [calories, protein, fat, carbs] = nums;

  const inRange = (v, lo, hi) => Number.isFinite(v) && v >= lo && v <= hi;
  if (!inRange(calories, 500, 8000) || !inRange(protein, 0, 600) || !inRange(fat, 0, 600) || !inRange(carbs, 0, 600)) {
    return ctx.reply(
      '⚠️ Проверь значения: калории 500–8000, белки/жиры/углеводы 0–600 г.\n\n' +
      'Пример: <code>/targets 2000 175 70 180</code>',
      { parse_mode: 'HTML' }
    );
  }

  const { error: updateError } = await supabase
    .from('users')
    .update({
      daily_calories:  calories,
      daily_protein_g: protein,
      daily_fat_g:     fat,
      daily_carbs_g:   carbs,
      updated_at:      new Date().toISOString(),
    })
    .eq('telegram_id', telegramId);

  if (updateError) {
    console.error('[/targets] update error:', updateError.message);
    return ctx.reply('❌ Не удалось сохранить цели. Попробуй ещё раз.');
  }

  return ctx.reply(
    `✅ <b>Цели обновлены:</b>\n\n` +
    `🔥 Калории:  <b>${calories}</b> ккал\n` +
    `🥩 Белки:    <b>${protein}</b> г\n` +
    `🧈 Жиры:     <b>${fat}</b> г\n` +
    `🍞 Углеводы: <b>${carbs}</b> г`,
    { parse_mode: 'HTML' }
  );
});

// ── /week — detailed 7-day export (.md document) ───────────────────────────
// Shared generator with GET /api/export/week/:userId — one report, not two.

bot.command(['week', 'неделя'], async (ctx) => {
  const telegramId = ctx.from.id;

  const { data: user, error: userError } = await supabase
    .from('users')
    .select('onboarding_complete')
    .eq('telegram_id', telegramId)
    .maybeSingle();

  if (userError) {
    console.error('[/week] user query error:', userError.message);
    return ctx.reply('Что-то пошло не так. Попробуй ещё раз.');
  }

  if (!user?.onboarding_complete) {
    return ctx.reply('Сначала заполни анкету — используй /start.');
  }

  await ctx.sendChatAction('upload_document');

  try {
    const report = await generateWeeklyReport(telegramId);
    if (!report) {
      return ctx.reply('Не удалось сформировать отчёт. Попробуй ещё раз.');
    }

    await ctx.replyWithDocument({
      source:   Buffer.from(report.content, 'utf-8'),
      filename: report.filename,
    });
  } catch (err) {
    console.error('[/week] error:', err.message);
    return ctx.reply('❌ Не удалось сформировать отчёт. Попробуй ещё раз.');
  }
});

// ── /reset — re-runs the onboarding wizard from step 1 ───────────────────

bot.command(['reset', 'сброс'], (ctx) => ctx.scene.enter('onboarding'));

// ── /help ──────────────────────────────────────────────────────────────────

bot.command('help', (ctx) => ctx.reply(
  `📘 <b>СПРАВКА ПО ВВОДУ</b>\n\n` +
  `📷 <b>Фото + подпись:</b>\n` +
  `Отправь фото блюда с текстовым описанием.\n` +
  `Пример: <i>«200г куриная грудка с рисом»</i>\n\n` +
  `📝 <b>Текстовый лог:</b>\n` +
  `Просто напиши название и вес — без фото.\n` +
  `Пример: <i>«Гречка отварная 200г»</i>\n\n` +
  `✍️ <b>Ручной ввод:</b>\n` +
  `<code>Ручной ввод: Название, Ккал, Белки, Жиры, Углеводы</code>\n` +
  `Пример: <code>Ручной ввод: Курица, 165, 31, 3, 0</code>\n\n` +
  `⚖️ <b>Вес:</b>\n` +
  `<code>/weight 82.5</code> — записать вес на сегодня (повторный ввод в тот же день перезаписывает)\n` +
  `<code>/weight</code> — посмотреть последнюю запись\n\n` +
  `👟 <b>Шаги:</b>\n` +
  `<code>/steps 8500</code> — записать шаги за сегодня (повторный ввод перезаписывает)\n` +
  `<code>/steps</code> — посмотреть сегодняшнее значение\n\n` +
  `🎯 <b>Цели по КБЖУ:</b>\n` +
  `<code>/targets 2000 175 70 180</code> — задать калории/белки/жиры/углеводы вручную (порядок именно такой)\n` +
  `<code>/targets</code> — посмотреть текущие цели\n\n` +
  `📄 <b>Отчёт:</b>\n` +
  `<code>/week</code> — подробный отчёт за 7 дней (.md-файл): все приёмы пищи, вес, шаги, вода, итоги недели\n\n` +
  `📌 <b>Команды:</b>\n` +
  `/dashboard — открыть дашборд КБЖУ\n` +
  `/profile — пересчитать цели\n` +
  `/today — прогресс за сегодня\n` +
  `/weight — вес\n` +
  `/steps — шаги\n` +
  `/targets — изменить цели\n` +
  `/week — отчёт за неделю`,
  { parse_mode: 'HTML' }
));

// ── /сегодня ───────────────────────────────────────────────────────────────

bot.command(['today', 'сегодня'], async (ctx) => {
  const today = todayMSK();
  const telegramId = ctx.from.id;

  const [logsResult, userResult] = await Promise.all([
    supabase
      .from('food_logs')
      .select('calories, protein_g, fat_g, carbs_g, description, logged_at')
      .eq('telegram_id', telegramId)
      .eq('log_date', today)
      .order('logged_at', { ascending: true }),
    supabase
      .from('users')
      .select('daily_calories, daily_protein_g, daily_fat_g, daily_carbs_g')
      .eq('telegram_id', telegramId)
      .maybeSingle(),
  ]);

  if (logsResult.error) {
    console.error('[/today] DB error:', logsResult.error.message);
    return ctx.reply('Не удалось загрузить данные. Попробуй ещё раз.');
  }

  if (!userResult.data) {
    return ctx.reply('Профиль не найден. Используй /start для настройки.');
  }

  const logs = logsResult.data ?? [];
  const user = userResult.data;

  const totals = logs.reduce(
    (acc, row) => ({
      calories: acc.calories + (row.calories ?? 0),
      protein:  acc.protein  + parseFloat(row.protein_g ?? 0),
      fat:      acc.fat      + parseFloat(row.fat_g     ?? 0),
      carbs:    acc.carbs    + parseFloat(row.carbs_g   ?? 0),
    }),
    { calories: 0, protein: 0, fat: 0, carbs: 0 }
  );

  const pct   = (v, t) => t > 0 ? Math.round((v / t) * 100) : 0;
  const bar   = (v, t) => {
    const filled = Math.min(10, Math.round((v / t) * 10));
    return '█'.repeat(filled) + '░'.repeat(10 - filled);
  };

  const logLines = logs.length
    ? logs.map((r, i) => `${i + 1}. ${r.description} — ${r.calories} ккал`).join('\n')
    : 'Приёмов пищи пока нет.';

  return ctx.reply(
    `📅 Сегодня, ${today}\n\n` +
    `🔥 ${totals.calories} / ${user.daily_calories} ккал (${pct(totals.calories, user.daily_calories)}%)\n` +
    `${bar(totals.calories, user.daily_calories)}\n\n` +
    `🥩 Белки:    ${Math.round(totals.protein)} / ${user.daily_protein_g} г\n` +
    `🧈 Жиры:     ${Math.round(totals.fat)} / ${user.daily_fat_g} г\n` +
    `🍞 Углеводы: ${Math.round(totals.carbs)} / ${user.daily_carbs_g} г\n\n` +
    `Приёмы пищи:\n${logLines}`
  );
});

// ── /дашборд ───────────────────────────────────────────────────────────────

bot.command(['dashboard', 'дашборд'], async (ctx) => {
  const { data: user } = await supabase
    .from('users')
    .select('onboarding_complete')
    .eq('telegram_id', ctx.from.id)
    .maybeSingle();

  if (!user?.onboarding_complete) {
    return ctx.reply('Сначала заполни анкету — используй /start.');
  }

  const url = process.env.WEBAPP_URL;
  if (!url || url.includes('your-webapp')) {
    return ctx.reply(
      '⚠️ WEBAPP_URL не настроен.\n\n' +
      'Запусти туннель:\n' +
      'npx localtunnel --port 3000\n\n' +
      'Затем обнови .env и перезапусти бота.'
    );
  }

  return ctx.reply(
    '📊 Открой дашборд:',
    Markup.inlineKeyboard([
      [Markup.button.webApp('Открыть Dashboard', url)],
    ])
  );
});

// ── /test_msg — connectivity smoke test ────────────────────────────────────

bot.command('test_msg', async (ctx) => {
  console.log(`DEBUG: /test_msg вызван из чата ${ctx.chat.id} пользователем ${ctx.from.id}`);
  try {
    await ctx.reply('Связь работает ✅');
    console.log(`DEBUG: /test_msg — сообщение доставлено в чат ${ctx.chat.id}`);
  } catch (err) {
    console.error(`DEBUG: /test_msg — sendMessage failed for chat ${ctx.chat.id}:`, err.message);
  }
});

// ── inline button actions ───────────────────────────────────────────────────

bot.action('confirm_log', handleConfirmLog);
bot.action('cancel_log',  handleCancelLog);

// ── photo handler ──────────────────────────────────────────────────────────

bot.on('photo', async (ctx) => {
  const { data: user } = await supabase
    .from('users')
    .select('onboarding_complete')
    .eq('telegram_id', ctx.from.id)
    .maybeSingle();

  if (!user?.onboarding_complete) {
    return ctx.reply('Сначала заполни анкету — используй /start.');
  }

  return handleFoodPhoto(ctx);
});

// ── text handler ────────────────────────────────────────────────────────────
// Priority: correction of pending log → manual entry → AI food analysis.

bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim();
  if (text.startsWith('/')) return;

  // If a pending preview exists, any text is a correction — skip DB check
  // because the user is already onboarded (they got the preview).
  if (ctx.session?.pendingLog) {
    return handleCorrectionText(ctx);
  }

  const { data: user } = await supabase
    .from('users')
    .select('onboarding_complete')
    .eq('telegram_id', ctx.from.id)
    .maybeSingle();

  if (!user?.onboarding_complete) {
    return ctx.reply('Используй /start, чтобы заполнить анкету.');
  }

  if (text.toLowerCase().startsWith('ручной ввод:')) {
    return handleManualEntry(ctx);
  }

  return handleFoodText(ctx);
});

module.exports = { bot };
