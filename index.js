require('dotenv').config();

// ── Startup env validation ─────────────────────────────────────────────────
const REQUIRED_ENV = [
  'TELEGRAM_BOT_TOKEN',
  'OPENAI_API_KEY',
  'SUPABASE_URL',
  'SUPABASE_KEY',
];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
  console.error('❌ Missing required environment variables:', missing.join(', '));
  process.exit(1);
}

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const { bot }           = require('./src/bot');
const { supabase }      = require('./src/db/supabase');
const { initScheduler } = require('./src/services/scheduler');
const { todayMSK }      = require('./src/utils/time');

// ── Express API ────────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'src/webapp')));

// Health-check — used by uptime monitors (UptimeRobot, Better Stack, etc.)
app.get('/ping', (_req, res) => res.send('OK'));

// GET today's data for the Web App dashboard
app.get('/api/today/:userId', async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  if (isNaN(userId)) return res.status(400).json({ error: 'Invalid userId' });

  const today = todayMSK();

  const [userResult, logsResult, waterResult] = await Promise.all([
    supabase
      .from('users')
      .select('daily_calories, daily_protein_g, daily_fat_g, daily_carbs_g, first_name, username, goal, target_water_ml')
      .eq('telegram_id', userId)
      .maybeSingle(),
    supabase
      .from('food_logs')
      .select('id, calories, protein_g, fat_g, carbs_g, description, logged_at, photo_file_id, raw_ai_response')
      .eq('telegram_id', userId)
      .eq('log_date', today)
      .order('logged_at', { ascending: true }),
    supabase
      .from('water_logs')
      .select('amount_ml')
      .eq('telegram_id', userId)
      .eq('log_date', today),
  ]);

  if (!userResult.data) {
    return res.status(404).json({ error: 'User not found' });
  }

  const waterLogged = waterResult.error
    ? 0
    : (waterResult.data ?? []).reduce((sum, r) => sum + (r.amount_ml || 0), 0);

  res.json({
    user:        userResult.data,
    logs:        logsResult.data ?? [],
    date:        today,
    waterLogged,
  });
});

// POST — log 250 ml of water for today; returns confirmed daily total
app.post('/api/water', async (req, res) => {
  const telegramId = parseInt(req.body.userId, 10);
  const amount     = Math.max(1, Math.round(Number(req.body.amount) || 250));

  if (isNaN(telegramId)) return res.status(400).json({ error: 'Invalid userId' });

  const today = todayMSK();

  const { error: insertError } = await supabase.from('water_logs').insert({
    telegram_id: telegramId,
    log_date:    today,
    amount_ml:   amount,
  });

  if (insertError) return res.status(500).json({ error: insertError.message });

  // Return the server-confirmed total so the client needs no further requests
  const { data: rows, error: sumError } = await supabase
    .from('water_logs')
    .select('amount_ml')
    .eq('telegram_id', telegramId)
    .eq('log_date', today);

  const waterLogged = sumError
    ? 0
    : (rows ?? []).reduce((s, r) => s + (r.amount_ml || 0), 0);

  res.json({ ok: true, waterLogged });
});

// GET historical data for any MSK date (YYYY-MM-DD)
app.get('/api/logs/:userId/:date', async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  const date   = req.params.date;

  if (isNaN(userId)) return res.status(400).json({ error: 'Invalid userId' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date format' });
  if (date > todayMSK()) return res.status(400).json({ error: 'Future date not allowed' });

  const [userResult, logsResult, waterResult] = await Promise.all([
    supabase
      .from('users')
      .select('daily_calories, daily_protein_g, daily_fat_g, daily_carbs_g, first_name, username, goal, target_water_ml')
      .eq('telegram_id', userId)
      .maybeSingle(),
    supabase
      .from('food_logs')
      .select('id, calories, protein_g, fat_g, carbs_g, description, logged_at, photo_file_id, raw_ai_response')
      .eq('telegram_id', userId)
      .eq('log_date', date)
      .order('logged_at', { ascending: true }),
    supabase
      .from('water_logs')
      .select('amount_ml')
      .eq('telegram_id', userId)
      .eq('log_date', date),
  ]);

  if (!userResult.data) return res.status(404).json({ error: 'User not found' });

  const waterLogged = waterResult.error
    ? 0
    : (waterResult.data ?? []).reduce((s, r) => s + (r.amount_ml || 0), 0);

  res.json({
    user:        userResult.data,
    logs:        logsResult.data ?? [],
    date,
    waterLogged,
  });
});

// DELETE a specific food log (ownership enforced via telegram_id)
app.delete('/api/logs/:id', async (req, res) => {
  const logId     = parseInt(req.params.id, 10);
  const telegramId = parseInt(req.query.userId, 10);

  if (isNaN(logId) || isNaN(telegramId)) {
    return res.status(400).json({ error: 'Invalid params' });
  }

  const { error } = await supabase
    .from('food_logs')
    .delete()
    .eq('id', logId)
    .eq('telegram_id', telegramId);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// PUT — update macros (and optionally weight) for a specific food log
app.put('/api/logs/:id', async (req, res) => {
  const logId      = parseInt(req.params.id, 10);
  const telegramId = parseInt(req.query.userId, 10);

  if (isNaN(logId) || isNaN(telegramId)) {
    return res.status(400).json({ error: 'Invalid params' });
  }

  const toNonNeg = v => {
    const n = Math.round(Number(v));
    return isFinite(n) && n >= 0 ? n : null;
  };

  const cal = toNonNeg(req.body.calories);
  const pro = toNonNeg(req.body.protein_g);
  const fat = toNonNeg(req.body.fat_g);
  const car = toNonNeg(req.body.carbs_g);

  if ([cal, pro, fat, car].some(v => v === null)) {
    return res.status(400).json({ error: 'Invalid macro values' });
  }

  const update = { calories: cal, protein_g: pro, fat_g: fat, carbs_g: car };

  // Merge updated weight into raw_ai_response JSONB if provided
  const wt = toNonNeg(req.body.weight_g);
  if (wt !== null) {
    const { data: existing } = await supabase
      .from('food_logs')
      .select('raw_ai_response')
      .eq('id', logId)
      .eq('telegram_id', telegramId)
      .maybeSingle();

    if (existing) {
      update.raw_ai_response = {
        ...(existing.raw_ai_response || {}),
        assumed_weight_g: wt,
      };
    }
  }

  const { error } = await supabase
    .from('food_logs')
    .update(update)
    .eq('id', logId)
    .eq('telegram_id', telegramId);

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.listen(3000, () => console.log('🌐 Web App server → http://localhost:3000'));

// ── Telegraf Bot ───────────────────────────────────────────────────────────

bot.launch().then(async () => {
  console.log('✅ Bot is fully running...');

  // Register slash command autocomplete list
  await bot.telegram.setMyCommands([
    { command: 'start',     description: 'Перезапуск бота' },
    { command: 'dashboard', description: 'Открыть матрицу КБЖУ' },
    { command: 'profile',   description: 'Настроить цели и параметры' },
    { command: 'help',      description: 'Справка по вводу' },
  ]).catch(err => console.error('[commands] setMyCommands error:', err.message));

  // Set persistent Web App button next to the input field
  if (process.env.WEBAPP_URL) {
    await bot.telegram.setChatMenuButton({
      menu_button: {
        type: 'web_app',
        text: 'Дашборд',
        web_app: { url: process.env.WEBAPP_URL },
      },
    }).catch(err => console.error('[menu-button] setChatMenuButton error:', err.message));
  }

  initScheduler(bot);
});

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
