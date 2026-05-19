require('dotenv').config();

// ── Startup env validation ─────────────────────────────────────────────────
const REQUIRED_ENV = [
  'TELEGRAM_BOT_TOKEN',
  'OPENAI_API_KEY',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
  console.error('❌ Missing required environment variables:', missing.join(', '));
  process.exit(1);
}

const crypto  = require('crypto');
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const { bot }           = require('./src/bot');
const { supabase }      = require('./src/db/supabase');
const { initScheduler } = require('./src/services/scheduler');
const { todayMSK }      = require('./src/utils/time');

// ── Express API ────────────────────────────────────────────────────────────

const app = express();
app.use(cors({ origin: process.env.WEBAPP_URL }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'src/webapp')));

// ── Telegram initData verification (HMAC-SHA256) ───────────────────────────
// Spec: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app

function verifyTelegramInitData(initData, botToken) {
  const params = new URLSearchParams(initData);
  const hash   = params.get('hash');
  if (!hash) return null;

  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData')
    .update(botToken)
    .digest();

  const expectedHash = crypto.createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex');

  let valid = false;
  try {
    valid = crypto.timingSafeEqual(
      Buffer.from(hash,         'hex'),
      Buffer.from(expectedHash, 'hex')
    );
  } catch {
    return null;
  }

  if (!valid) return null;

  try {
    const userStr = params.get('user');
    return userStr ? JSON.parse(userStr) : {};
  } catch {
    return null;
  }
}

// Applied to every /api/* route.
// In non-production (local dev with ?uid=), verification is skipped so
// browser testing via the tunnel remains possible without a live Telegram session.
function requireTelegramAuth(req, res, next) {
  if (process.env.NODE_ENV !== 'production') return next();

  const auth = req.headers.authorization;
  if (!auth?.startsWith('tma ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const user = verifyTelegramInitData(auth.slice(4), process.env.TELEGRAM_BOT_TOKEN);
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  req.telegramUser = user;
  next();
}

app.use('/api', requireTelegramAuth);

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

// POST — log water for today; returns confirmed daily total
app.post('/api/water', async (req, res) => {
  const telegramId = parseInt(req.body.userId, 10);
  const amount     = Math.max(1, Math.round(Number(req.body.amount) || 250));

  if (isNaN(telegramId)) return res.status(400).json({ error: 'Invalid userId' });

  const today = todayMSK();

  // Fetch user's water target and current day total in parallel (pre-insert check)
  const [userRow, existingRows] = await Promise.all([
    supabase.from('users').select('target_water_ml').eq('telegram_id', telegramId).maybeSingle(),
    supabase.from('water_logs').select('amount_ml').eq('telegram_id', telegramId).eq('log_date', today),
  ]);

  const target   = userRow.data?.target_water_ml ?? 2500;
  const existing = (existingRows.data ?? []).reduce((s, r) => s + (r.amount_ml || 0), 0);

  // Cap at 2× the user's daily target to prevent log flooding
  if (existing + amount > target * 2) {
    return res.status(400).json({ error: 'Daily water limit exceeded' });
  }

  const { error: insertError } = await supabase.from('water_logs').insert({
    telegram_id: telegramId,
    log_date:    today,
    amount_ml:   amount,
  });

  if (insertError) {
    console.error('[/api/water] insert error:', insertError.message);
    return res.status(500).json({ error: 'Internal server error' });
  }

  // Return computed total — no second DB round-trip needed
  res.json({ ok: true, waterLogged: existing + amount });
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

  if (error) {
    console.error('[DELETE /api/logs] error:', error.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
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

  if (error) {
    console.error('[PUT /api/logs] error:', error.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
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
