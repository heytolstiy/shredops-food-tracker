# Simple Food & Water Tracker in Telegram

A Telegram bot + embedded Mini App for calorie, macro, and water tracking. Users log meals by sending food photos or plain text; OpenAI Vision analyzes the image and returns macros in JSON. A web dashboard renders daily progress in real time with a 90-day historical timeline.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Bot runtime | Node.js 20 + [Telegraf v4](https://telegrafjs.org/) |
| Web server | Express v5 |
| Database | Supabase (PostgreSQL) via `@supabase/supabase-js` v2 |
| AI analysis | OpenAI `gpt-4o-mini` with Vision + JSON mode |
| Frontend | Vanilla JS / CSS (no framework), Telegram Web App SDK |
| Scheduler | `node-cron` v4 |
| Module system | CommonJS (`"type": "commonjs"`) |

---

## Project Structure

```
simple-food-water-tracker/
├── index.js                    # Entry point: Express server + bot launch
├── database.sql                # Full schema for a fresh Supabase project
├── migration_water.sql         # ALTER TABLE migration (adds target_water_ml + water_logs)
├── package.json
├── .env                        # Secret keys — never commit this
└── src/
    ├── bot/
    │   ├── index.js            # Telegraf bot, all command handlers
    │   ├── handlers/
    │   │   └── food.js         # Photo, text, and manual food log handlers
    │   └── scenes/
    │       └── onboarding.js   # 8-step WizardScene: profile setup
    ├── db/
    │   └── supabase.js         # Supabase client singleton
    ├── services/
    │   ├── calories.js         # Mifflin-St Jeor TDEE + macro split calculator
    │   ├── vision.js           # OpenAI Vision food analysis wrapper
    │   └── scheduler.js        # node-cron daily broadcast jobs
    ├── utils/
    │   └── time.js             # todayMSK() — single timezone source of truth
    └── webapp/
        ├── index.html          # Mini App shell (served as static by Express)
        ├── style.css           # UI design system
        └── app.js              # Mini App logic: timeline, water, logs, edit/delete
```

---

## Environment Variables

Create a `.env` file in the project root. All variables below are required.

```env
TELEGRAM_BOT_TOKEN=          # Bot token from @BotFather
OPENAI_API_KEY=              # OpenAI API key with gpt-4o-mini access
SUPABASE_URL=                # Your Supabase project URL (https://xxx.supabase.co)
SUPABASE_SERVICE_ROLE_KEY=   # service_role secret key — NOT the anon/public key
NODE_ENV=production          # Set to "production" to enable strict API auth
WEBAPP_URL=                  # Public HTTPS URL of the Mini App (used for CORS)
```

### Key notes

- **`SUPABASE_SERVICE_ROLE_KEY`** must be the `service_role` secret key, not the `anon` public key. The bot writes data server-side, and `service_role` bypasses Row Level Security so no RLS policies need to be configured.
- **`NODE_ENV=production`** activates strict Telegram `initData` HMAC-SHA256 signature verification on every `/api/*` request. Without it (local dev), the middleware is bypassed so browser testing via a tunnel remains possible without a live Telegram session.
- **`WEBAPP_URL`** must be a valid public HTTPS URL. It is used to restrict CORS: only requests from this origin are accepted by the Express API. Telegram also rejects `http://` and `localhost` Mini App URLs — use a tunnel during local development (see setup below).

---

## Installation & Local Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

Create a `.env` file in the project root and fill in your keys (see the table above).

### 3. Set up the database

In your Supabase dashboard → **SQL Editor** → **New query**:

- **Fresh project:** paste and run `database.sql`
- **Existing project (if you previously ran the base schema):** paste and run `migration_water.sql`

### 4. Start a public HTTPS tunnel (local dev only)

Telegram Mini Apps require HTTPS. Use any tunnel tool:

```bash
# Option A — localtunnel (no account needed)
npx localtunnel --port 3000

# Option B — ngrok (more stable, requires free account)
ngrok http 3000
```

Copy the generated `https://` URL into your `.env` as `WEBAPP_URL`, then restart the bot.

> **VS Code users:** if you're using VS Code port forwarding, go to the **Ports** tab, right-click port `3000`, and set visibility to **Public**. Copy the forwarded address as `WEBAPP_URL`.

### 5. Run the bot

```bash
# Production
npm start

# Development (auto-restarts on file changes — Node 20+)
npm run dev
```

Both the Express API and the Telegraf bot start from the same `index.js` entry point. You should see:

```
🌐 Web App server → http://localhost:3000
✅ Bot is fully running...
✅ Scheduler running (TZ: Europe/Moscow) — jobs: 09:00 / 16:00 / 20:00 / 23:00 MSK
```

---

## Bot Commands

| Command | Description |
|---|---|
| `/start` | Welcome message if onboarded; launches profile wizard for new users |
| `/profile` | Read-only summary of current profile: biometrics, targets, macros, water goal |
| `/reset` | Clears current state and re-runs the full 8-step onboarding wizard |
| `/dashboard` | Sends an inline button that opens the Mini App web dashboard |
| `/help` | Usage guide for all three logging methods (photo, text, manual) |

### Logging methods

| Method | Format | Example |
|---|---|---|
| Photo + caption | Send a food photo with a text description | Photo with caption `"200г куриная грудка с рисом"` |
| Text only | Plain message with food name and weight | `"Гречка отварная 200г"` |
| Manual entry | Structured prefix format | `"Ручной ввод: Куриная грудка, 165, 31, 3, 0"` |

---

## Web App (Mini App) Features

- **Hero card** — big calorie number with progress bar, goal badge, surplus/deficit display
- **Macro grid** — protein / fat / carbs with individual progress bars
- **Water tracker** — gamified power cells (250 ml each), tap to log
- **Historical timeline** — horizontal scrollable 90-day strip; tap any day to view that date read-only
- **Food log** — per-entry cards with edit and delete actions (today only)
- **Edit modal** — update calories, macros, and portion weight inline

---

## Security

The production API is secured at multiple layers:

- **Telegram `initData` verification** — every `/api/*` request must include an `Authorization: tma <initData>` header. The server verifies the HMAC-SHA256 signature using the bot token as the secret key, per the [Telegram Mini App spec](https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app). Requests with missing or invalid signatures are rejected with `401 Unauthorized`.
- **Anti-XSS escaping** — all user-supplied strings (food names, usernames, goal labels) are HTML-entity-escaped before being injected into the Mini App DOM.
- **Water rate limiting** — the `POST /api/water` endpoint enforces a per-user daily cap of `2 × target_water_ml`. Requests that would exceed this limit are rejected with `400` before any DB write occurs.
- **CORS restriction** — the Express API only accepts cross-origin requests from the `WEBAPP_URL` origin.
- **Error masking** — internal DB error details are logged server-side only; clients receive a generic `"Internal server error"` string.

---

## Deployment

The app is a single Node.js process. Any platform that runs Node.js works:

- **Railway / Render / Fly.io** — push repo, set env vars in the platform dashboard, deploy
- **VPS** — run with `pm2 start index.js --name food-tracker`

Set all six environment variables in your platform's dashboard before deploying. The bot registers the Menu Button and command list automatically on startup.
