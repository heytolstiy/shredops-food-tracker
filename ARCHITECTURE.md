# Simple Food & Water Tracker in Telegram — Architecture Reference

Technical blueprint for developers and AI sessions maintaining this codebase. Covers every non-obvious decision: why it exists, what it does, and what breaks if you change it.

---

## Table of Contents

1. [System Overview](#system-overview)
2. [Request Flow](#request-flow)
3. [Database Schema](#database-schema)
4. [Timezone Architecture](#timezone-architecture)
5. [Food Analysis Pipeline](#food-analysis-pipeline)
6. [TDEE & Macro Calculation](#tdee--macro-calculation)
7. [Onboarding Scene](#onboarding-scene)
8. [Scheduler Jobs](#scheduler-jobs)
9. [API Endpoints](#api-endpoints)
10. [State Management & Edge Cases](#state-management--edge-cases)
11. [Frontend Architecture](#frontend-architecture)

---

## System Overview

One Node.js process runs two concurrent systems from `index.js`:

```
index.js
├── Express (port 3000)
│   ├── Static file server  →  src/webapp/ (Mini App HTML/CSS/JS)
│   └── REST API            →  /api/* routes
└── Telegraf bot
    ├── Command handlers    →  src/bot/index.js
    ├── WizardScene         →  src/bot/scenes/onboarding.js
    ├── Food handlers       →  src/bot/handlers/food.js
    └── Scheduler           →  src/services/scheduler.js
```

The Supabase client is a singleton (`src/db/supabase.js`) shared by all modules — one connection pool for both the bot and the API.

---

## Request Flow

### Food photo log

```
User sends photo + caption
  → bot.on('photo') in src/bot/index.js
  → handleFoodPhoto() checks onboarding_complete
  → analyzeFood(photoUrl, caption) → OpenAI gpt-4o-mini → JSON
  → if !is_food → reply NON_FOOD_REPLY, stop
  → saveAndReply() → INSERT into food_logs → SELECT day totals → reply summary
```

### Mini App water tap

```
User taps a water cell in the Mini App
  → logWater() sets waterPending = true, fills cell optimistically
  → POST /api/water { userId, amount: 250 }
  → Express inserts water_log row, queries SUM(amount_ml) for today
  → returns { ok: true, waterLogged: <confirmed total> }
  → client sets currentWaterLogged = waterLogged, re-renders water section
  → waterPending = false
```

---

## Database Schema

### `users`

Stores one row per Telegram user. Written by the onboarding wizard via upsert on `telegram_id`.

```sql
CREATE TABLE users (
  id                  BIGSERIAL PRIMARY KEY,
  telegram_id         BIGINT UNIQUE NOT NULL,   -- Telegram user ID, lookup key everywhere
  username            TEXT,
  first_name          TEXT,
  gender              TEXT NOT NULL CHECK (gender IN ('male', 'female')),
  age                 INTEGER NOT NULL CHECK (age BETWEEN 10 AND 120),
  height_cm           INTEGER NOT NULL CHECK (height_cm BETWEEN 100 AND 250),
  weight_kg           NUMERIC(5,2) NOT NULL CHECK (weight_kg BETWEEN 20 AND 300),
  activity_level      TEXT NOT NULL CHECK (activity_level IN (
                        'sedentary', 'light', 'moderate', 'active', 'very_active')),
  goal                TEXT NOT NULL CHECK (goal IN ('lose', 'maintain', 'gain')),
  daily_calories      INTEGER NOT NULL,          -- Adjusted TDEE (kcal/day)
  daily_protein_g     INTEGER NOT NULL,          -- Grams per day
  daily_fat_g         INTEGER NOT NULL,
  daily_carbs_g       INTEGER NOT NULL,
  target_water_ml     INTEGER DEFAULT 2500,      -- weight_kg × 33, rounded
  onboarding_complete BOOLEAN DEFAULT FALSE,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);
```

> **`target_water_ml`** was added via `migration_water.sql`. It is NOT in the original `database.sql` CREATE TABLE statement — it was added with `ALTER TABLE users ADD COLUMN IF NOT EXISTS target_water_ml INTEGER DEFAULT 2500`. The current `database.sql` has been updated to include it for fresh deployments.

### `food_logs`

One row per meal/snack. The `raw_ai_response` JSONB stores the full OpenAI output and is the source of truth for `identified_food`, `assumed_weight_g`, and the `manual: true` flag for manual entries.

```sql
CREATE TABLE food_logs (
  id               BIGSERIAL PRIMARY KEY,
  telegram_id      BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  logged_at        TIMESTAMPTZ DEFAULT NOW(),
  log_date         DATE NOT NULL DEFAULT CURRENT_DATE,
  description      TEXT NOT NULL,          -- Raw user caption/text
  photo_file_id    TEXT,                   -- Telegram file_id; NULL for text-only logs
  calories         INTEGER NOT NULL,
  protein_g        NUMERIC(6,2) NOT NULL,
  fat_g            NUMERIC(6,2) NOT NULL,
  carbs_g          NUMERIC(6,2) NOT NULL,
  fiber_g          NUMERIC(6,2),           -- Not currently used
  meal_type        TEXT DEFAULT 'snack',   -- Not currently used
  raw_ai_response  JSONB                   -- { identified_food, assumed_weight_g, raw, manual? }
);

CREATE INDEX idx_food_logs_telegram_date ON food_logs(telegram_id, log_date);
```

**`raw_ai_response` structure:**

```json
{
  "identified_food":  "Куриная грудка отварная",
  "assumed_weight_g": 200,
  "raw":              "<original OpenAI JSON string>",
  "manual":           true   // only present for manual entries (raw is null in that case)
}
```

The Mini App reads `raw_ai_response.identified_food` as the display name (falling back to `description`). The `PUT /api/logs/:id` endpoint merges `assumed_weight_g` into this JSONB when the user edits portion weight.

### `water_logs`

One row per tap. Aggregated by `SUM(amount_ml)` per `(telegram_id, log_date)` pair — never updated, only inserted.

```sql
CREATE TABLE water_logs (
  id           BIGSERIAL PRIMARY KEY,
  telegram_id  BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  logged_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  log_date     DATE NOT NULL DEFAULT CURRENT_DATE,
  amount_ml    INTEGER NOT NULL DEFAULT 250
);

CREATE INDEX idx_water_logs_telegram_date ON water_logs(telegram_id, log_date);
```

### Migrations

```sql
-- migration_water.sql — run on any existing deployment that has the base schema
ALTER TABLE users ADD COLUMN IF NOT EXISTS target_water_ml INTEGER DEFAULT 2500;

CREATE TABLE IF NOT EXISTS water_logs (
  id           BIGSERIAL PRIMARY KEY,
  telegram_id  BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  logged_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  log_date     DATE NOT NULL DEFAULT CURRENT_DATE,
  amount_ml    INTEGER NOT NULL DEFAULT 250
);

CREATE INDEX IF NOT EXISTS idx_water_logs_telegram_date ON water_logs(telegram_id, log_date);
ALTER TABLE water_logs ENABLE ROW LEVEL SECURITY;
```

### Row Level Security

RLS is enabled on all three tables. The bot uses the `service_role` key which bypasses RLS entirely, so no policies are needed for the bot to function. RLS acts as a safety net against accidental direct access with the `anon` key.

---

## Timezone Architecture

**The entire system is hardcoded to Moscow Standard Time (MSK, UTC+3, no DST).**

This is a deliberate, explicit design choice — not a default. It does not depend on the host server's locale, system timezone, or any OS/ICU timezone database.

### Why a fixed offset instead of `'Europe/Moscow'` system tz

Using `new Date().toLocaleDateString()` or relying on the server's `TZ` environment variable would produce wrong "today" boundaries if the bot is deployed on a UTC server (which all cloud platforms default to). A user logging food at 23:30 MSK would get it assigned to the wrong date.

### Implementation

**Server-side** (`src/utils/time.js`):
```javascript
const MSK_OFFSET_MS = 3 * 60 * 60 * 1000; // UTC+3, no DST adjustment ever needed

function todayMSK() {
  return new Date(Date.now() + MSK_OFFSET_MS).toISOString().slice(0, 10);
}
```

This function is the single source of truth for "today's date." It is imported and called everywhere a date boundary is needed — never duplicated inline.

**Client-side** (`src/webapp/app.js`):
```javascript
function mskToday() {
  return new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
```

Identical math in the browser, so the Mini App's "today" boundary always matches the server's, regardless of the user's local timezone.

**Scheduler** (`src/services/scheduler.js`):
```javascript
const TZ = 'Europe/Moscow';
cron.schedule('0 9 * * *', () => morningBrief(bot), { timezone: TZ });
```

`node-cron` accepts a IANA timezone string and handles DST transitions internally. `'Europe/Moscow'` has had no DST since March 2014, so it is permanently UTC+3 and will never shift.

### Files that use `todayMSK()` / `mskToday()`

| File | Purpose |
|---|---|
| `src/utils/time.js` | Definition |
| `src/bot/handlers/food.js` | `log_date` on INSERT |
| `src/bot/index.js` | `/today` command date filter |
| `index.js` | `GET /api/today`, `POST /api/water` date filters |
| `src/services/scheduler.js` | Inactivity check + evening summary date filter |
| `src/webapp/app.js` | Timeline "today" boundary, `activeDate` init, route selection |

---

## Food Analysis Pipeline

All food analysis goes through `src/services/vision.js`.

### OpenAI call

- **Model:** `gpt-4o-mini`
- **Mode:** JSON object (`response_format: { type: 'json_object' }`)
- **Max tokens:** 400
- **Vision:** `detail: 'low'` — sufficient for food recognition, cheaper than `high`

### System prompt rules (in order)

1. **Identification** — if the object is not food, return `is_food: false` and zeros. This prevents logging a photo of a dog or a screwdriver.
2. **Text priority** — user-supplied weight and composition override visual estimation.
3. **Weight estimation** — if no weight is given, estimate from visual cues or use standard package weight.
4. **No hidden ingredients** — never assume oil, sauce, or condiments unless visible or stated.
5. **Format** — strict JSON, no markdown, no explanation prose.

### Response schema

```json
{
  "is_food":          true,
  "calories":         350,
  "protein":          32,
  "carbs":            15,
  "fat":              8,
  "identified_food":  "Куриная грудка отварная",
  "assumed_weight_g": 200
}
```

All seven fields are validated after parsing. A missing field throws and the user receives an error reply.

### Non-food guard

Both `handleFoodPhoto` and `handleFoodText` check `!nutrition.is_food` before calling `saveAndReply`. If `is_food` is false, the entry is **not saved** and the user receives a prompt to use manual entry instead.

### Manual entry bypass

The format `"Ручной ввод: Название, Ккал, Белки, Жиры, Углеводы"` skips the AI entirely. The handler parses the CSV, constructs a `nutrition` object with `raw: null` and `manual: true`, and passes it to `saveAndReply`.

---

## TDEE & Macro Calculation

`src/services/calories.js` — pure functions, no side effects.

### TDEE formula (Mifflin-St Jeor)

```
BMR (male)   = 10 × weight_kg + 6.25 × height_cm − 5 × age + 5
BMR (female) = 10 × weight_kg + 6.25 × height_cm − 5 × age − 161

TDEE = BMR × activity_multiplier × goal_multiplier
```

### Activity multipliers

| Level | Key | Multiplier |
|---|---|---|
| Sedentary | `sedentary` | ×1.200 |
| Light exercise | `light` | ×1.375 |
| Moderate exercise | `moderate` | ×1.550 |
| Active | `active` | ×1.725 |
| Very active | `very_active` | ×1.900 |

### Goal modifiers

| Goal | Key | Modifier |
|---|---|---|
| Cut (deficit) | `lose` | ×0.80 (−20%) |
| Maintain | `maintain` | ×1.00 |
| Bulk (surplus) | `gain` | ×1.20 (+20%) |

### Macro splits

Macros are calculated from calorie percentages. Protein and carbs = 4 kcal/g; fat = 9 kcal/g.

| Split | Key | Protein | Fat | Carbs |
|---|---|---|---|---|
| Balanced | `balanced` | 30% | 30% | 40% |
| High protein | `high_protein` | 40% | 30% | 30% |
| Low carb | `low_carb` | 40% | 40% | 20% |

### Water target

```javascript
target_water_ml = Math.round(weight_kg * 33)
```

Saved to `users.target_water_ml` during the final onboarding step. The Mini App reads this field to size the power cell row (6–10 cells, clamped).

---

## Onboarding Scene

`src/bot/scenes/onboarding.js` — Telegraf `WizardScene` with 8 steps.

| Step | Handler | Collects | Validates |
|---|---|---|---|
| 0 | `askGender` | — | — |
| 1 | `askAge` | `gender` | `'Мужской'` / `'Женский'` only |
| 2 | `askWeight` | `age` | 10–120 integer |
| 3 | `askHeight` | `weight_kg` | 20–300, accepts comma decimal |
| 4 | `askActivity` | `height_cm` | 100–250 integer |
| 5 | `askGoal` | `activity_level` | button-only |
| 6 | `askMacroSplit` | `goal` | button-only, calculates TDEE |
| 7 | `finish` | `macro_split` | button-only, saves to DB |

All intermediate data lives in `ctx.wizard.state` for the duration of the scene. On completion, a single upsert writes the full row using `onConflict: 'telegram_id'`, which handles both new users and profile updates.

The scene is entered via `/start` (new users) and `/reset` (recalibration). `/profile` is a separate read-only handler — it queries the `users` table and formats a static summary; it never enters the scene.

---

## Scheduler Jobs

`src/services/scheduler.js` — three `node-cron` jobs, all in MSK timezone.

| Time (MSK) | Job | What it does |
|---|---|---|
| 09:00 | Morning brief | Sends each user their daily calorie/macro targets |
| 16:00 & 20:00 | Inactivity check | Sends a nudge only to users who have **zero** food logs today |
| 23:00 | Evening summary | Sends a full day report with totals, percentage, and status badge |

### Efficiency pattern

Inactivity check and evening summary both use a **two-query, in-JS cross-reference** pattern to avoid N+1 database calls:

```javascript
const [users, logsResult] = await Promise.all([
  getActiveUsers(),                                      // all onboarded users
  supabase.from('food_logs').select('telegram_id')       // all IDs that logged today
    .eq('log_date', today),
]);

const loggedIds = new Set(logsResult.data.map(r => r.telegram_id));
const silent    = users.filter(u => !loggedIds.has(u.telegram_id));
```

Total: 2 queries regardless of user count.

### Error handling

`send()` swallows known Telegram errors silently (403 bot blocked, 400 chat not found) and only logs unexpected errors — preventing scheduler job crashes when a user blocks the bot.

---

## API Endpoints

All routes are in `index.js`. All user-scoped mutations verify `telegram_id` ownership via `.eq('telegram_id', telegramId)`.

### Authentication middleware

Every `/api/*` route is protected by `requireTelegramAuth`:

```javascript
app.use('/api', requireTelegramAuth);
```

In **production** (`NODE_ENV === 'production'`), the middleware requires an `Authorization: tma <initData>` header and verifies the Telegram `initData` HMAC-SHA256 signature:

1. Strip the `hash` field from the URL-encoded `initData` string.
2. Sort the remaining key=value pairs lexicographically and join with `\n` to form the data-check string.
3. Derive the secret key: `HMAC-SHA256("WebAppData", TELEGRAM_BOT_TOKEN)`.
4. Compute `HMAC-SHA256(data_check_string, secret_key)` and compare with `hash` using `crypto.timingSafeEqual` to prevent timing attacks.

Requests that are missing the header, or whose signature does not match, receive `401 Unauthorized`. The parsed `user` object is attached to `req.telegramUser` for downstream use.

In **non-production** (local dev), the middleware is bypassed entirely so browser testing via a tunnel works without a live Telegram session.

---

### `GET /ping`

Health check for uptime monitors (UptimeRobot, Better Stack, etc.).

**Response:** `200 OK` — plain text `"OK"`

---

### `GET /api/today/:userId`

Returns all data needed to render the Mini App dashboard for the current MSK date.

**Response:**
```json
{
  "user": {
    "first_name": "Евгений",
    "username": "evgeny",
    "goal": "lose",
    "daily_calories": 1840,
    "daily_protein_g": 138,
    "daily_fat_g": 61,
    "daily_carbs_g": 184,
    "target_water_ml": 2640
  },
  "logs": [
    {
      "id": 42,
      "calories": 350,
      "protein_g": "32.00",
      "fat_g": "8.00",
      "carbs_g": "15.00",
      "description": "200г куриная грудка",
      "logged_at": "2026-05-19T10:23:00+00:00",
      "photo_file_id": "AgACAgI...",
      "raw_ai_response": { "identified_food": "Куриная грудка", "assumed_weight_g": 200 }
    }
  ],
  "date": "2026-05-19",
  "waterLogged": 750
}
```

**Errors:** `400` invalid userId · `404` user not found

---

### `GET /api/logs/:userId/:date`

Returns the same shape as `/api/today` but for any historical MSK date (`YYYY-MM-DD`). Used by the Mini App timeline when the user selects a past day.

**Validation:**
- `date` must match `/^\d{4}-\d{2}-\d{2}$/`
- `date` must not be in the future (compared via string sort against `todayMSK()`)

**Response:** identical shape to `/api/today`

**Errors:** `400` invalid userId · `400` invalid date format · `400` future date not allowed · `404` user not found

---

### `POST /api/water`

Logs one water drink and returns the server-confirmed day total. The confirmed total is used by the client to resolve any optimistic UI race conditions.

**Request body:**
```json
{ "userId": 123456789, "amount": 250 }
```

`amount` is validated with `Math.max(1, Math.round(Number(...)))`. Defaults to 250 if missing.

Before inserting, the endpoint fetches the user's `target_water_ml` and the current day's running total in parallel. If `existing + amount > target * 2`, the request is rejected with `400` (daily cap exceeded). This rate limit check happens **before** the insert — no row is written.

On success, `waterLogged` is computed as `existing + amount` locally — no second DB round-trip needed.

**Response:**
```json
{ "ok": true, "waterLogged": 1000 }
```

`waterLogged` is the server-confirmed day total, used by the client to resolve optimistic UI race conditions.

**Errors:** `400` invalid userId · `400` daily water limit exceeded · `500` DB error

---

### `PUT /api/logs/:id`

Updates macros and optionally the portion weight for a food log entry. Ownership enforced: the row must have `telegram_id = userId` or the update affects 0 rows silently.

**Query param:** `?userId=<telegramId>`

**Request body:**
```json
{
  "calories":  350,
  "protein_g": 32,
  "fat_g":     8,
  "carbs_g":   15,
  "weight_g":  200
}
```

All five values are validated as non-negative integers. If `weight_g` is provided, it is merged into `raw_ai_response` JSONB as `assumed_weight_g` via a read-modify-write (fetch existing JSONB → spread → update).

**Response:** `{ "ok": true }`

**Errors:** `400` invalid params · `400` invalid macro values · `500` DB error

---

### `DELETE /api/logs/:id`

Deletes a food log entry. Ownership enforced via `telegram_id`.

**Query param:** `?userId=<telegramId>`

**Response:** `{ "ok": true }`

**Errors:** `400` invalid params · `500` DB error

---

## State Management & Edge Cases

### Water click race condition fix

**Problem:** If the user taps multiple water cells rapidly before the first POST completes, multiple simultaneous requests fire. Each one inserts independently, and the client's optimistic counter becomes desynchronized from the real DB total.

**Solution (three-part):**

1. **Lock** — `waterPending = false` boolean. `logWater()` checks `if (waterPending) return` before doing anything. Only one request can be in-flight at a time.

2. **Visual feedback** — while pending, the `.water-cells` div gets class `.pending` (CSS: `opacity: 0.55; pointer-events: none`), giving the user clear feedback that the tap registered.

3. **Server-authoritative update** — on success, `currentWaterLogged` is set from `res.waterLogged` (the confirmed DB total), not from `currentWaterLogged + 250`. The water section is fully re-rendered from this confirmed value, so any drift between optimistic state and real state is corrected on every request.

**Rollback** — on network failure, the optimistic cell fill is removed and the counter resets to the pre-tap value.

---

### Infinite historical timeline

**Mechanism:**

On boot, `initTimeline()` generates 90 day-cards using UTC arithmetic to avoid local timezone skew:

```javascript
for (let i = 89; i >= 0; i--) {
  const mskMs = Date.now() + 3 * 60 * 60 * 1000 - i * 86400000;
  const d     = new Date(mskMs);
  const ymd   = d.toISOString().slice(0, 10);  // YYYY-MM-DD in MSK
  const dow   = d.getUTCDay();                 // weekday without local tz conversion
  const day   = d.getUTCDate();
}
```

Using `getUTCDay()` and `getUTCDate()` (not `getDay()` / `getDate()`) prevents the browser's local timezone from shifting the apparent weekday.

Today is always the **rightmost** card. `tl.scrollLeft = tl.scrollWidth` snaps to it on init.

**Date selection flow:**

```
User taps day-card
  → selectDate(date)
  → activeDate = date
  → viewingPast = (date < mskToday())
  → setTimelineActive(date)   // updates CSS class + scrollIntoView
  → loadData()                // fetches /api/logs/:userId/:date or /api/today/:userId
  → render(data)              // re-renders all sections with viewingPast flag in scope
```

**Read-only enforcement for past days:**

`viewingPast` is a module-level boolean read by every render function:

- `logCard()` — omits the `<div class="lc-actions">` block entirely if `viewingPast`
- `waterHTML()` — adds `.readonly` CSS class to `.water-cells` and changes hint text
- Event delegation — `if (viewingPast) return` guard before any edit/delete/water handler

Past data is read-only at the UI level. There are no server-side guards against writing to past dates (the API accepts any date), so the enforcement is intentionally client-only: it prevents accidental edits, not adversarial ones.

---

### Bot registration lifecycle

The onboarding wizard upserts on `telegram_id` with `{ onConflict: 'telegram_id' }`. This means:

- **New user:** row is inserted on first `/start` + wizard completion
- **Returning user:** same wizard flow overwrites all fields except `created_at`

The `onboarding_complete: false` default means the bot always requires the wizard before logging. There is no auto-registration fallback — if a user somehow bypasses onboarding, they see a prompt to run `/start`.

---

## Frontend Architecture

`src/webapp/app.js` is a single-file vanilla JS module. No bundler, no framework.

### Module-level state

```javascript
let currentLogs        = [];      // food_logs for active date
let editingLogId       = null;    // ID of the log being edited in modal
let currentWaterLogged = 0;       // confirmed ml logged today
let currentWaterTarget = 2500;    // from user.target_water_ml
let waterPending       = false;   // race condition lock
let activeDate         = mskToday(); // YYYY-MM-DD currently displayed
let viewingPast        = false;   // true when activeDate < mskToday()
```

### Render pattern

All rendering is string-interpolated HTML injected via `innerHTML`. There is no virtual DOM or diffing. A full `render(data)` call replaces all four sections (`#hero-section`, `#macro-section`, `#water-section`, `#log-section`). The water section has an additional lightweight path (`syncWaterDisplay()`) that updates only the counter text node during the optimistic fill phase to avoid re-rendering the cells before the server responds.

### Event delegation

A single `document.addEventListener('click', ...)` handles all interactive elements using `e.target.closest(selector)`. This works correctly because all interactive content is dynamically rendered into the DOM.

### Telegram Web App SDK

- `tg.initDataUnsafe.user.id` — real user ID in production; falls back to `?uid=` query param for browser testing
- `tg.HapticFeedback.impactOccurred('light')` — tactile feedback on water tap
- `tg.showConfirm(msg, callback)` — native Telegram confirmation dialog for delete; falls back to `window.confirm` in browser
- `tg.expand()` — forces the Mini App to full height on open
