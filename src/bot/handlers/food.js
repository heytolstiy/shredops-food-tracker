const { supabase }   = require('../../db/supabase');
const { analyzeFood } = require('../../services/vision');
const { todayMSK }   = require('../../utils/time');

const NON_FOOD_REPLY =
  '⚠️ Объект не распознан как еда.\n\n' +
  'Отправь фото еды или введи данные вручную в формате:\n\n' +
  '<code>Ручной ввод: Название, Ккал, Белки, Жиры, Углеводы</code>\n\n' +
  'Пример:\n<code>Ручной ввод: Куриная грудка, 165, 31, 3, 0</code>';

function sign(n) {
  const rounded = Math.round(n);
  return rounded >= 0 ? `${rounded}` : `−${Math.abs(rounded)}`;
}

// ── Shared save + reply ─────────────────────────────────────────────────────

async function saveAndReply(ctx, nutrition, description, photoFileId) {
  const telegramId = ctx.from.id;
  const today      = todayMSK();

  const { error: insertError } = await supabase.from('food_logs').insert({
    telegram_id:     telegramId,
    log_date:        today,
    description,
    photo_file_id:   photoFileId ?? null,
    calories:        nutrition.calories,
    protein_g:       nutrition.protein,
    fat_g:           nutrition.fat,
    carbs_g:         nutrition.carbs,
    raw_ai_response: {
      identified_food:  nutrition.identified_food,
      assumed_weight_g: nutrition.assumed_weight_g,
      raw:              nutrition.raw ?? null,
      ...(nutrition.raw === null ? { manual: true } : {}),
    },
  });

  if (insertError) {
    console.error('[food] DB insert error:', insertError.message);
    return ctx.reply('❌ Не удалось сохранить запись. Попробуй ещё раз.');
  }

  const [logsResult, userResult] = await Promise.all([
    supabase
      .from('food_logs')
      .select('calories, protein_g, fat_g, carbs_g')
      .eq('telegram_id', telegramId)
      .eq('log_date', today),
    supabase
      .from('users')
      .select('daily_calories, daily_protein_g, daily_fat_g, daily_carbs_g')
      .eq('telegram_id', telegramId)
      .maybeSingle(),
  ]);

  if (logsResult.error) {
    console.error('[food] DB totals error:', logsResult.error.message);
    return ctx.reply(`✅ Записано: ${nutrition.identified_food} (${nutrition.calories} ккал)`);
  }

  const totals = (logsResult.data ?? []).reduce(
    (acc, r) => ({
      calories: acc.calories + (r.calories ?? 0),
      protein:  acc.protein  + parseFloat(r.protein_g ?? 0),
      fat:      acc.fat      + parseFloat(r.fat_g     ?? 0),
      carbs:    acc.carbs    + parseFloat(r.carbs_g   ?? 0),
    }),
    { calories: 0, protein: 0, fat: 0, carbs: 0 }
  );

  const user       = userResult.data;
  const rem        = {
    calories: (user?.daily_calories  ?? 0) - totals.calories,
    protein:  (user?.daily_protein_g ?? 0) - totals.protein,
    fat:      (user?.daily_fat_g     ?? 0) - totals.fat,
    carbs:    (user?.daily_carbs_g   ?? 0) - totals.carbs,
  };
  const source     = photoFileId ? '📷' : '📝';
  const weightStr  = nutrition.assumed_weight_g > 0 ? ` (${nutrition.assumed_weight_g}г)` : '';

  return ctx.reply(
    `${source} Записано: ${nutrition.identified_food}${weightStr} — ${nutrition.calories} ккал\n` +
    `Б ${nutrition.protein}г · Ж ${nutrition.fat}г · У ${nutrition.carbs}г\n\n` +
    `📊 Итого за сегодня: ${totals.calories} / ${user?.daily_calories ?? '?'} ккал\n\n` +
    `Остаток на день:\n` +
    `🔥 Калории: ${sign(rem.calories)} ккал\n` +
    `🥩 Белки:   ${sign(rem.protein)} г\n` +
    `🧈 Жиры:    ${sign(rem.fat)} г\n` +
    `🍞 Углеводы: ${sign(rem.carbs)} г`
  );
}

// ── Photo handler ───────────────────────────────────────────────────────────

async function handleFoodPhoto(ctx) {
  if (!ctx.message.caption) {
    return ctx.reply(
      '⚠️ Пожалуйста, добавь описание еды и примерный вес в граммах.\n\n' +
      'Пример: отправь фото с подписью «200г куриная грудка с рисом»\n\n' +
      'Или просто напиши название блюда текстом — фото необязательно.'
    );
  }

  await ctx.sendChatAction('typing');

  try {
    const photos    = ctx.message.photo;
    const bestPhoto = photos[photos.length - 1];
    const fileLink  = await ctx.telegram.getFileLink(bestPhoto.file_id);

    await ctx.sendChatAction('typing');

    const nutrition = await analyzeFood(fileLink.href, ctx.message.caption);

    if (!nutrition.is_food) {
      return ctx.reply(NON_FOOD_REPLY, { parse_mode: 'HTML' });
    }

    return saveAndReply(ctx, nutrition, ctx.message.caption, bestPhoto.file_id);
  } catch (err) {
    console.error('[food/photo] FULL ERROR:', err);
    return ctx.reply('❌ Не удалось проанализировать фото.\n\nУбедись, что на фото видна еда, и попробуй снова.');
  }
}

// ── Text-only AI handler ────────────────────────────────────────────────────

async function handleFoodText(ctx) {
  const text = ctx.message.text.trim();
  await ctx.sendChatAction('typing');

  try {
    const nutrition = await analyzeFood(null, text);

    if (!nutrition.is_food) {
      return ctx.reply(NON_FOOD_REPLY, { parse_mode: 'HTML' });
    }

    return saveAndReply(ctx, nutrition, text, null);
  } catch (err) {
    console.error('[food/text] FULL ERROR:', err);
    return ctx.reply('❌ Не удалось рассчитать КБЖУ.\n\nПопробуй добавить больше деталей, например: «Гречка отварная 200г».');
  }
}

// ── Manual entry handler ────────────────────────────────────────────────────
// Expected format: "Ручной ввод: Название, Ккал, Белки, Жиры, Углеводы"

async function handleManualEntry(ctx) {
  const text    = ctx.message.text.trim();
  const payload = text.slice('Ручной ввод:'.length).trim(); // everything after the prefix
  const parts   = payload.split(',').map(s => s.trim());

  if (parts.length < 5 || !parts[0]) {
    return ctx.reply(
      '⚠️ Неверный формат. Используй:\n\n' +
      '<b>Ручной ввод: Название, Ккал, Белки, Жиры, Углеводы</b>\n\n' +
      'Пример:\n<code>Ручной ввод: Куриная грудка, 165, 31, 3, 0</code>',
      { parse_mode: 'HTML' }
    );
  }

  // Name may contain commas — take everything except the last 4 parts as the name
  const nums = parts.slice(-4).map(s => Math.round(Number(s)));
  const name = parts.slice(0, parts.length - 4).join(', ') || parts[0];

  if (nums.some(n => isNaN(n) || n < 0)) {
    return ctx.reply(
      '⚠️ Неверные числа. Проверь формат:\n\n' +
      '<code>Ручной ввод: Куриная грудка, 165, 31, 3, 0</code>',
      { parse_mode: 'HTML' }
    );
  }

  const [calories, protein, fat, carbs] = nums;

  const nutrition = {
    is_food:          true,
    calories,
    protein,
    fat,
    carbs,
    identified_food:  name,
    assumed_weight_g: 0,
    raw:              null,
  };

  return saveAndReply(ctx, nutrition, text, null);
}

module.exports = { handleFoodPhoto, handleFoodText, handleManualEntry };
