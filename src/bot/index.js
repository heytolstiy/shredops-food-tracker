const { Telegraf, Scenes, session, Markup } = require('telegraf');
const { onboardingScene } = require('./scenes/onboarding');
const { handleFoodPhoto, handleFoodText, handleManualEntry } = require('./handlers/food');
const { supabase }   = require('../db/supabase');
const { todayMSK }   = require('../utils/time');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// ── middleware ─────────────────────────────────────────────────────────────

const stage = new Scenes.Stage([onboardingScene]);
bot.use(session());
bot.use(stage.middleware());

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
  `📌 <b>Команды:</b>\n` +
  `/dashboard — открыть дашборд КБЖУ\n` +
  `/profile — пересчитать цели\n` +
  `/today — прогресс за сегодня`,
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

// ── text-only food logging ──────────────────────────────────────────────────
// Fires for plain text messages that are not commands and not inside a scene.

bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim();
  if (text.startsWith('/')) return;

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
