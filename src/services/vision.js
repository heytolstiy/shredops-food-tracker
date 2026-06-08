const OpenAI = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_PROMPT = `Ты — профессиональный нутрициолог и точный калькулятор КБЖУ.

ПРАВИЛО 1 (ИДЕНТИФИКАЦИЯ): Если объект явно НЕ является едой — верни "is_food": false и 0 для всех числовых полей. Для любой реальной еды "is_food" ВСЕГДА true.

ПРАВИЛО 2 (ЗАПРЕТ НУЛЕЙ): СТРОГО ЗАПРЕЩЕНО возвращать 0 для calories, protein, fat или carbs, если блюдо является реальной едой. Для сложных блюд (шаурма, бургер, борщ, пицца, суши, паста, плов, пельмени и т.д.) ОБЯЗАТЕЛЬНО используй средние ресторанные или рецептурные значения — никогда не возвращай нули под предлогом "неизвестного состава".

ПРАВИЛО 3 (ПРИОРИТЕТ ТЕКСТА): Если пользователь указал вес и состав — это абсолютная истина. Считай КБЖУ строго по его данным.

ПРАВИЛО 4 (ОЦЕНКА ВЕСА): Если вес не указан — оцени самостоятельно по фото (размер порции, визуальные ориентиры) или используй стандартный вес порции данного блюда.

ПРАВИЛО 5 (СЛЕПЫЕ ЗОНЫ): НИКОГДА не добавляй скрытые ингредиенты, масло или соусы, если они не указаны в тексте или явно не видны на фото.

ПРАВИЛО 6 (ФОРМАТ): Верни СТРОГО JSON без markdown и пояснений. Поле "assumptions" ОБЯЗАТЕЛЬНО идёт ПЕРВЫМ — это твоё краткое объяснение допущений по весу и составу (1-2 предложения на русском). Оно помогает обосновать расчёт до его выполнения.

Формат ответа:
{
  "assumptions": "Принял порцию за 350г — стандартная шаурма в лаваше со свининой и овощами.",
  "is_food": true,
  "identified_food": "Название блюда на русском",
  "assumed_weight_g": 350,
  "calories": 680,
  "protein": 28,
  "fat": 32,
  "carbs": 65
}

Все числа — целые. Никакого markdown, никаких пояснений вне JSON.`;

async function analyzeFood(imageBase64, caption) {
  let userContent;

  if (imageBase64) {
    userContent = [
      {
        type: 'text',
        text: caption
          ? `Описание от пользователя: ${caption}`
          : 'Определи блюдо на фото и рассчитай КБЖУ. Описания от пользователя нет.',
      },
      {
        type: 'image_url',
        image_url: {
          url:    `data:image/jpeg;base64,${imageBase64}`,
          detail: 'low',
        },
      },
    ];
  } else {
    userContent = `Описание от пользователя: ${caption}`;
  }

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    response_format: { type: 'json_object' },
    max_tokens: 500,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user',   content: userContent  },
    ],
  });

  return parseResponse(response.choices[0].message.content);
}

async function analyzeFoodCorrection(originalInput, currentNutrition, correction) {
  const context =
    `Исходный запрос: "${originalInput}"\n` +
    `Текущий расчёт: ${currentNutrition.identified_food}, ${currentNutrition.assumed_weight_g}г — ` +
    `${currentNutrition.calories} ккал, Б:${currentNutrition.protein}г, Ж:${currentNutrition.fat}г, У:${currentNutrition.carbs}г\n` +
    `Допущения: ${currentNutrition.assumptions}\n\n` +
    `Пользователь вносит правку: "${correction}"\n\n` +
    `Пересчитай КБЖУ с учётом правки. Верни обновлённый JSON.`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    response_format: { type: 'json_object' },
    max_tokens: 500,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user',   content: context },
    ],
  });

  return parseResponse(response.choices[0].message.content);
}

function parseResponse(raw) {
  const parsed = JSON.parse(raw);

  for (const field of ['is_food', 'assumptions', 'identified_food', 'assumed_weight_g', 'calories', 'protein', 'fat', 'carbs']) {
    if (parsed[field] === undefined) {
      throw new Error(`OpenAI response missing field: ${field}. Raw: ${raw}`);
    }
  }

  return {
    is_food:          Boolean(parsed.is_food),
    assumptions:      String(parsed.assumptions),
    identified_food:  String(parsed.identified_food),
    assumed_weight_g: Math.round(Number(parsed.assumed_weight_g)),
    calories:         Math.round(Number(parsed.calories)),
    protein:          Math.round(Number(parsed.protein)),
    fat:              Math.round(Number(parsed.fat)),
    carbs:            Math.round(Number(parsed.carbs)),
    raw,
  };
}

module.exports = { analyzeFood, analyzeFoodCorrection };
