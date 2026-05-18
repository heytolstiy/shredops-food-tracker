const { Scenes, Markup } = require('telegraf');
const { supabase }       = require('../../db/supabase');
const { calculateTDEE, calculateMacros } = require('../../services/calories');

// ── Lookup tables ──────────────────────────────────────────────────────────

const ACTIVITY_MAP = {
  'Сидячий':       'sedentary',
  'Лёгкая':        'light',
  'Умеренная':     'moderate',
  'Высокая':       'active',
  'Очень высокая': 'very_active',
};

const ACTIVITY_LABEL = {
  sedentary:   'Сидячий (×1.2)',
  light:       'Лёгкая (×1.375)',
  moderate:    'Умеренная (×1.55)',
  active:      'Высокая (×1.725)',
  very_active: 'Очень высокая (×1.9)',
};

const GOAL_MAP = {
  'Сушка':       'lose',
  'Поддержание': 'maintain',
  'Масса':       'gain',
};

const GOAL_LABEL = {
  lose:     'Сушка (−20%)',
  maintain: 'Поддержание',
  gain:     'Масса (+20%)',
};

const SPLIT_MAP = {
  'Сбалансированный': 'balanced',
  'Высокобелковый':   'high_protein',
  'Низкоуглеводный':  'low_carb',
};

const SPLIT_LABEL = {
  balanced:     'Сбалансированный · Б30 / Ж30 / У40',
  high_protein: 'Высокобелковый · Б40 / Ж30 / У30',
  low_carb:     'Низкоуглеводный · Б40 / Ж40 / У20',
};

// ── Helpers ────────────────────────────────────────────────────────────────

function warn(ctx, msg) {
  return ctx.reply(`⚠️ ${msg}`);
}

// ── Wizard steps ───────────────────────────────────────────────────────────

// Step 0 — entry: greet + ask gender
async function askGender(ctx) {
  const name = ctx.from.first_name ? `, ${ctx.from.first_name}` : '';
  await ctx.reply(
    `⚡️ Настройка профиля${name}.\n\n` +
    `Отвечай на вопросы — система рассчитает твою программу питания.\n\n` +
    `Шаг 1 / 6 — Пол:`,
    Markup.keyboard([['Мужской', 'Женский']]).oneTime().resize()
  );
  return ctx.wizard.next();
}

// Step 1 — store gender, ask age
async function askAge(ctx) {
  const text = ctx.message?.text;
  if (text !== 'Мужской' && text !== 'Женский') {
    return warn(ctx, 'Выбери пол кнопкой: Мужской или Женский.');
  }
  ctx.wizard.state.gender = text === 'Мужской' ? 'male' : 'female';
  await ctx.reply('Шаг 2 / 6 — Возраст (лет):', Markup.removeKeyboard());
  return ctx.wizard.next();
}

// Step 2 — store age, ask weight
async function askWeight(ctx) {
  const age = parseInt(ctx.message?.text, 10);
  if (isNaN(age) || age < 10 || age > 120) {
    return warn(ctx, 'Введи возраст числом от 10 до 120.');
  }
  ctx.wizard.state.age = age;
  await ctx.reply('Шаг 3 / 6 — Текущий вес (кг), например 82.5:');
  return ctx.wizard.next();
}

// Step 3 — store weight, ask height
async function askHeight(ctx) {
  const weight = parseFloat(ctx.message?.text?.replace(',', '.'));
  if (isNaN(weight) || weight < 20 || weight > 300) {
    return warn(ctx, 'Введи вес числом от 20 до 300 кг.');
  }
  ctx.wizard.state.weightKg = weight;
  await ctx.reply('Шаг 4 / 6 — Рост (см), например 181:');
  return ctx.wizard.next();
}

// Step 4 — store height, ask activity
async function askActivity(ctx) {
  const height = parseInt(ctx.message?.text, 10);
  if (isNaN(height) || height < 100 || height > 250) {
    return warn(ctx, 'Введи рост числом от 100 до 250 см.');
  }
  ctx.wizard.state.heightCm = height;
  await ctx.reply(
    'Шаг 5 / 6 — Уровень активности:',
    Markup.keyboard([
      ['Сидячий'],
      ['Лёгкая'],
      ['Умеренная'],
      ['Высокая'],
      ['Очень высокая'],
    ]).oneTime().resize()
  );
  return ctx.wizard.next();
}

// Step 5 — store activity, ask goal
async function askGoal(ctx) {
  const activity = ACTIVITY_MAP[ctx.message?.text];
  if (!activity) {
    return warn(ctx, 'Выбери уровень активности кнопкой.');
  }
  ctx.wizard.state.activityLevel = activity;
  await ctx.reply(
    'Шаг 6 / 6 — Цель:',
    Markup.keyboard([['Сушка', 'Поддержание', 'Масса']]).oneTime().resize()
  );
  return ctx.wizard.next();
}

// Step 6 — store goal, calculate TDEE, ask macro split
async function askMacroSplit(ctx) {
  const goal = GOAL_MAP[ctx.message?.text];
  if (!goal) {
    return warn(ctx, 'Выбери цель кнопкой: Сушка, Поддержание или Масса.');
  }

  const { gender, age, heightCm, weightKg, activityLevel } = ctx.wizard.state;
  const dailyCalories = calculateTDEE(gender, age, heightCm, weightKg, activityLevel, goal);

  ctx.wizard.state.goal          = goal;
  ctx.wizard.state.dailyCalories = dailyCalories;

  await ctx.reply(
    `📊 Расчёт завершён.\n\n` +
    `Дневная норма калорий: <b>${dailyCalories} ккал</b>\n\n` +
    `Выбери распределение макронутриентов:`,
    {
      parse_mode: 'HTML',
      ...Markup.keyboard([
        ['Сбалансированный'],
        ['Высокобелковый', 'Низкоуглеводный'],
      ]).oneTime().resize(),
    }
  );
  return ctx.wizard.next();
}

// Step 7 — store split, calculate macros, save to DB, show summary
async function finish(ctx) {
  const split = SPLIT_MAP[ctx.message?.text];
  if (!split) {
    return warn(ctx, 'Выбери распределение кнопкой.');
  }

  const { gender, age, heightCm, weightKg, activityLevel, goal, dailyCalories } = ctx.wizard.state;
  const { dailyProteinG, dailyFatG, dailyCarbsG } = calculateMacros(dailyCalories, split);
  const targetWaterMl = Math.round(weightKg * 33);

  const { error } = await supabase.from('users').upsert(
    {
      telegram_id:         ctx.from.id,
      username:            ctx.from.username  ?? null,
      first_name:          ctx.from.first_name ?? null,
      gender,
      age,
      height_cm:           heightCm,
      weight_kg:           weightKg,
      activity_level:      activityLevel,
      goal,
      daily_calories:      dailyCalories,
      daily_protein_g:     dailyProteinG,
      daily_fat_g:         dailyFatG,
      daily_carbs_g:       dailyCarbsG,
      target_water_ml:     targetWaterMl,
      onboarding_complete: true,
      updated_at:          new Date().toISOString(),
    },
    { onConflict: 'telegram_id' }
  );

  if (error) {
    console.error('[profile] DB error:', error.message);
    await ctx.reply('❌ Не удалось сохранить профиль. Попробуй ещё раз — /profile.');
    return ctx.scene.leave();
  }

  const genderLabel = gender === 'male' ? 'Мужской' : 'Женский';

  await ctx.reply(
    `⚡️ <b>ПРОТОКОЛ ОБНОВЛЁН</b>\n\n` +
    `👤 Биометрика:\n` +
    `${genderLabel} · ${age} лет · ${weightKg} кг · ${heightCm} см\n` +
    `${ACTIVITY_LABEL[activityLevel]} · ${GOAL_LABEL[goal]}\n\n` +
    `📊 Дневная программа — ${SPLIT_LABEL[split]}:\n\n` +
    `🔥 Калории:  <b>${dailyCalories}</b> ккал\n` +
    `🥩 Белки:    <b>${dailyProteinG}</b> г\n` +
    `🧈 Жиры:     <b>${dailyFatG}</b> г\n` +
    `🍞 Углеводы: <b>${dailyCarbsG}</b> г\n\n` +
    `Протокол активен. Отправь фото или название блюда — начинай логировать.`,
    { parse_mode: 'HTML', ...Markup.removeKeyboard() }
  );

  return ctx.scene.leave();
}

// ── Scene assembly ─────────────────────────────────────────────────────────

const onboardingScene = new Scenes.WizardScene(
  'onboarding',
  askGender,
  askAge,
  askWeight,
  askHeight,
  askActivity,
  askGoal,
  askMacroSplit,
  finish
);

module.exports = { onboardingScene };
