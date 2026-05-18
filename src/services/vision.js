const OpenAI = require('openai');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_PROMPT = `Ты — безжалостный и точный калькулятор калорий. Твоя задача — проанализировать текст пользователя и фотографию.
ПРАВИЛО 1: ИДЕНТИФИКАЦИЯ. Сначала определи: является ли объект едой или напитком? Если объект явно НЕ является едой (гаечный ключ, собака, машина, мусор, кал, инструменты, животные без контекста еды и т.д.) — верни "is_food": false и 0 для всех числовых полей.
ПРАВИЛО 2: ПРИОРИТЕТ ТЕКСТА. Если пользователь указал вес и состав — это абсолютная истина. Считай макросы строго по его данным.
ПРАВИЛО 3: ОЦЕНКА ВЕСА. Если пользователь написал только название (или не указал вес), ты ОБЯЗАН оценить вес самостоятельно по фото (размер порции, визуальные ориентиры) или использовать стандартный вес заводского продукта.
ПРАВИЛО 4: СЛЕПЫЕ ЗОНЫ. НИКОГДА не выдумывай скрытые ингредиенты, масло, соусы, если их нет в тексте или они явно не видны на фото.
ПРАВИЛО 5: ФОРМАТ. Верни результат строго в виде JSON-объекта: { "is_food": boolean, "calories": number, "protein": number, "carbs": number, "fat": number, "identified_food": "Название на русском", "assumed_weight_g": number }. Все числа — целые. Никакого markdown, никаких пояснений.`;

async function analyzeFood(photoUrl, caption) {
  const userContent = photoUrl
    ? [
        { type: 'image_url', image_url: { url: photoUrl, detail: 'low' } },
        { type: 'text', text: `Описание от пользователя: ${caption}` },
      ]
    : `Описание от пользователя: ${caption}`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    response_format: { type: 'json_object' },
    max_tokens: 400,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user',   content: userContent  },
    ],
  });

  const raw    = response.choices[0].message.content;
  const parsed = JSON.parse(raw);

  for (const field of ['is_food', 'calories', 'protein', 'carbs', 'fat', 'identified_food', 'assumed_weight_g']) {
    if (parsed[field] === undefined) {
      throw new Error(`OpenAI не вернул поле: ${field}. Ответ: ${raw}`);
    }
  }

  return {
    is_food:          Boolean(parsed.is_food),
    calories:         Math.round(Number(parsed.calories)),
    protein:          Math.round(Number(parsed.protein)),
    carbs:            Math.round(Number(parsed.carbs)),
    fat:              Math.round(Number(parsed.fat)),
    identified_food:  String(parsed.identified_food),
    assumed_weight_g: Math.round(Number(parsed.assumed_weight_g)),
    raw,
  };
}

module.exports = { analyzeFood };
