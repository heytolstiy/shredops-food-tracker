const { Markup }     = require('telegraf');
const { supabase }   = require('../../db/supabase');
const { analyzeFood, analyzeFoodCorrection } = require('../../services/vision');
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

// ── Preview helpers ─────────────────────────────────────────────────────────

function buildPreviewText(nutrition) {
  const w = nutrition.assumed_weight_g > 0 ? ` (${nutrition.assumed_weight_g}г)` : '';
  return (
    `🍽 <b>${nutrition.identified_food}${w}</b>\n` +
    `💭 <i>${nutrition.assumptions}</i>\n\n` +
    `🔥 ${nutrition.calories} ккал  |  🥩 ${nutrition.protein}г  |  🧈 ${nutrition.fat}г  |  🍞 ${nutrition.carbs}г\n\n` +
    `Верно? Нажми «✅ Сохранить».\n` +
    `Нужно исправить вес или состав? Просто напиши в чат (например: «было 400г» или «добавь сыр»).`
  );
}

function previewKeyboard() {
  return Markup.inlineKeyboard([
    Markup.button.callback('✅ Сохранить', 'confirm_log'),
    Markup.button.callback('❌ Отмена',    'cancel_log'),
  ]);
}

// ── DB helpers ──────────────────────────────────────────────────────────────

async function insertLog(ctx, nutrition, description, photoFileId) {
  const telegramId = ctx.from.id;
  const today      = todayMSK();

  const { error } = await supabase.from('food_logs').insert({
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
      assumptions:      nutrition.assumptions ?? null,
      raw:              nutrition.raw ?? null,
      ...(nutrition.raw === null ? { manual: true } : {}),
    },
  });

  if (error) {
    console.error('[food] DB insert error:', error.message);
    return null;
  }

  return { telegramId, today };
}

async function buildTotalsText(telegramId, today, nutrition) {
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
    return `✅ Записано: ${nutrition.identified_food} (${nutrition.calories} ккал)`;
  }

  const totals = (logsResult.data ?? []).reduce(
    (acc, r) => ({
      calories: acc.calories + (r.calories ?? 0),
      protein:  acc.protein  + parseFloat(r.protein_g ?? 0),
      fat:      acc.fat      + parseFloat(r.fat_g     ?? 0),
      carbs:    acc.carbs    + parseFloat(r.carbs_g   ?? 0),
    }),
    { calories: 0, protein: 0, fat: 0, carbs: 0 },
  );

  const user = userResult.data;
  const rem  = {
    calories: (user?.daily_calories  ?? 0) - totals.calories,
    protein:  (user?.daily_protein_g ?? 0) - totals.protein,
    fat:      (user?.daily_fat_g     ?? 0) - totals.fat,
    carbs:    (user?.daily_carbs_g   ?? 0) - totals.carbs,
  };
  const w = (nutrition.assumed_weight_g ?? 0) > 0 ? ` (${nutrition.assumed_weight_g}г)` : '';

  return (
    `✅ Записано: ${nutrition.identified_food}${w} — ${nutrition.calories} ккал\n` +
    `Б ${nutrition.protein}г · Ж ${nutrition.fat}г · У ${nutrition.carbs}г\n\n` +
    `📊 Итого за сегодня: ${totals.calories} / ${user?.daily_calories ?? '?'} ккал\n\n` +
    `Остаток на день:\n` +
    `🔥 Калории: ${sign(rem.calories)} ккал\n` +
    `🥩 Белки:   ${sign(rem.protein)} г\n` +
    `🧈 Жиры:    ${sign(rem.fat)} г\n` +
    `🍞 Углеводы: ${sign(rem.carbs)} г`
  );
}

// ── Send preview (no DB write yet) ──────────────────────────────────────────

async function sendPreview(ctx, nutrition, originalText, photoFileId) {
  // Clean up any stale preview from a previous pending log
  if (ctx.session?.pendingLog?.previewMessageId) {
    await ctx.telegram
      .deleteMessage(ctx.chat.id, ctx.session.pendingLog.previewMessageId)
      .catch(() => {});
  }

  const sent = await ctx.reply(buildPreviewText(nutrition), {
    parse_mode: 'HTML',
    ...previewKeyboard(),
  });

  ctx.session.pendingLog = {
    nutrition,
    originalText,
    photoFileId:      photoFileId ?? null,
    previewMessageId: sent.message_id,
  };
}

// ── Image download helper ───────────────────────────────────────────────────

async function fetchImageAsBase64(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch image: ${response.status}`);
  const buffer = await response.arrayBuffer();
  return Buffer.from(buffer).toString('base64');
}

// ── Photo handler ───────────────────────────────────────────────────────────

async function handleFoodPhoto(ctx) {
  await ctx.sendChatAction('typing');

  try {
    const photos    = ctx.message.photo;
    const bestPhoto = photos[photos.length - 1];
    const fileLink  = await ctx.telegram.getFileLink(bestPhoto.file_id);

    await ctx.sendChatAction('typing');

    const base64Image = await fetchImageAsBase64(fileLink.href);
    const caption     = ctx.message.caption ?? null;
    const nutrition   = await analyzeFood(base64Image, caption);

    if (!nutrition.is_food) {
      return ctx.reply(NON_FOOD_REPLY, { parse_mode: 'HTML' });
    }

    // Use caption as description if provided, otherwise fall back to AI-identified name
    const description = caption ?? nutrition.identified_food;
    return sendPreview(ctx, nutrition, description, bestPhoto.file_id);
  } catch (err) {
    console.error('[food/photo] error:', err.message);
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

    return sendPreview(ctx, nutrition, text, null);
  } catch (err) {
    console.error('[food/text] error:', err.message);
    return ctx.reply('❌ Не удалось рассчитать КБЖУ.\n\nПопробуй добавить больше деталей, например: «Гречка отварная 200г».');
  }
}

// ── Action: confirm ──────────────────────────────────────────────────────────

async function handleConfirmLog(ctx) {
  await ctx.answerCbQuery();

  const pending = ctx.session?.pendingLog;
  if (!pending) {
    return ctx.editMessageText('⚠️ Нет данных для сохранения. Попробуй снова.');
  }

  const { nutrition, originalText, photoFileId } = pending;
  ctx.session.pendingLog = null;

  const saved = await insertLog(ctx, nutrition, originalText, photoFileId);
  if (!saved) {
    return ctx.editMessageText('❌ Ошибка при сохранении. Попробуй ещё раз.');
  }

  const totalsText = await buildTotalsText(saved.telegramId, saved.today, nutrition);
  return ctx.editMessageText(totalsText, {
    parse_mode:   'HTML',
    reply_markup: { inline_keyboard: [] },
  });
}

// ── Action: cancel ───────────────────────────────────────────────────────────

async function handleCancelLog(ctx) {
  await ctx.answerCbQuery();
  ctx.session.pendingLog = null;
  return ctx.deleteMessage();
}

// ── Conversational correction ─────────────────────────────────────────────

async function handleCorrectionText(ctx) {
  const text    = ctx.message.text.trim();
  const pending = ctx.session.pendingLog;

  await ctx.sendChatAction('typing');

  try {
    const updated = await analyzeFoodCorrection(
      pending.originalText,
      pending.nutrition,
      text,
    );

    if (!updated.is_food) {
      return ctx.reply(NON_FOOD_REPLY, { parse_mode: 'HTML' });
    }

    ctx.session.pendingLog = { ...pending, nutrition: updated };

    try {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        pending.previewMessageId,
        undefined,
        buildPreviewText(updated),
        { parse_mode: 'HTML', ...previewKeyboard() },
      );
    } catch (editErr) {
      // Message was deleted or stale — send a fresh preview instead
      console.warn('[food/correction] edit failed, re-sending preview:', editErr.message);
      await sendPreview(ctx, updated, pending.originalText, pending.photoFileId);
    }
  } catch (err) {
    console.error('[food/correction] error:', err.message);
    return ctx.reply('❌ Не удалось пересчитать. Попробуй переформулировать правку.');
  }
}

// ── Manual entry handler ────────────────────────────────────────────────────
// Bypasses OpenAI and the 2-step preview — user already specified exact values.

async function handleManualEntry(ctx) {
  const text    = ctx.message.text.trim();
  const payload = text.slice('Ручной ввод:'.length).trim();
  const parts   = payload.split(',').map(s => s.trim());

  if (parts.length < 5 || !parts[0]) {
    return ctx.reply(
      '⚠️ Неверный формат. Используй:\n\n' +
      '<b>Ручной ввод: Название, Ккал, Белки, Жиры, Углеводы</b>\n\n' +
      'Пример:\n<code>Ручной ввод: Куриная грудка, 165, 31, 3, 0</code>',
      { parse_mode: 'HTML' },
    );
  }

  const nums = parts.slice(-4).map(s => Math.round(Number(s)));
  const name = parts.slice(0, parts.length - 4).join(', ') || parts[0];

  if (nums.some(n => isNaN(n) || n < 0)) {
    return ctx.reply(
      '⚠️ Неверные числа. Проверь формат:\n\n' +
      '<code>Ручной ввод: Куриная грудка, 165, 31, 3, 0</code>',
      { parse_mode: 'HTML' },
    );
  }

  const [calories, protein, fat, carbs] = nums;
  const nutrition = {
    is_food:          true,
    assumptions:      'Введено вручную',
    identified_food:  name,
    assumed_weight_g: 0,
    calories,
    protein,
    fat,
    carbs,
    raw:              null,
  };

  const saved = await insertLog(ctx, nutrition, text, null);
  if (!saved) {
    return ctx.reply('❌ Не удалось сохранить запись. Попробуй ещё раз.');
  }

  const reply = await buildTotalsText(saved.telegramId, saved.today, nutrition);
  return ctx.reply(reply, { parse_mode: 'HTML' });
}

module.exports = {
  handleFoodPhoto,
  handleFoodText,
  handleManualEntry,
  handleConfirmLog,
  handleCancelLog,
  handleCorrectionText,
};
