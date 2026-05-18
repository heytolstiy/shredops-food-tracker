-- ============================================================
-- FOOD TRACKER BOT — COMPLETE DATABASE SCHEMA
-- Run this entire file on a FRESH Supabase project.
-- For an existing project, run migration_water.sql instead.
--
-- Steps:
--   1. Open Supabase project dashboard
--   2. SQL Editor → New query
--   3. Paste this file and click Run
-- ============================================================


-- ── USERS ────────────────────────────────────────────────────────────────────
-- Stores profile data collected during onboarding.
-- telegram_id is the primary lookup key for all queries.
CREATE TABLE IF NOT EXISTS users (
  id                  BIGSERIAL PRIMARY KEY,
  telegram_id         BIGINT UNIQUE NOT NULL,
  username            TEXT,
  first_name          TEXT,
  gender              TEXT NOT NULL CHECK (gender IN ('male', 'female')),
  age                 INTEGER NOT NULL CHECK (age BETWEEN 10 AND 120),
  height_cm           INTEGER NOT NULL CHECK (height_cm BETWEEN 100 AND 250),
  weight_kg           NUMERIC(5,2) NOT NULL CHECK (weight_kg BETWEEN 20 AND 300),
  activity_level      TEXT NOT NULL CHECK (activity_level IN ('sedentary', 'light', 'moderate', 'active', 'very_active')),
  goal                TEXT NOT NULL CHECK (goal IN ('lose', 'maintain', 'gain')),
  daily_calories      INTEGER NOT NULL,
  daily_protein_g     INTEGER NOT NULL,
  daily_fat_g         INTEGER NOT NULL,
  daily_carbs_g       INTEGER NOT NULL,
  target_water_ml     INTEGER DEFAULT 2500,  -- added: migration_water.sql
  onboarding_complete BOOLEAN DEFAULT FALSE,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);


-- ── FOOD LOGS ─────────────────────────────────────────────────────────────────
-- One row per meal/snack logged via photo or text.
-- raw_ai_response stores the full OpenAI JSON for debugging and reprocessing.
CREATE TABLE IF NOT EXISTS food_logs (
  id               BIGSERIAL PRIMARY KEY,
  telegram_id      BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  logged_at        TIMESTAMPTZ DEFAULT NOW(),
  log_date         DATE NOT NULL DEFAULT CURRENT_DATE,
  description      TEXT NOT NULL,
  photo_file_id    TEXT,
  calories         INTEGER NOT NULL,
  protein_g        NUMERIC(6,2) NOT NULL,
  fat_g            NUMERIC(6,2) NOT NULL,
  carbs_g          NUMERIC(6,2) NOT NULL,
  fiber_g          NUMERIC(6,2),
  meal_type        TEXT DEFAULT 'snack' CHECK (meal_type IN ('breakfast', 'lunch', 'dinner', 'snack')),
  raw_ai_response  JSONB
);

CREATE INDEX IF NOT EXISTS idx_food_logs_telegram_date
  ON food_logs(telegram_id, log_date);


-- ── WATER LOGS ────────────────────────────────────────────────────────────────
-- One row per water tap (default 250 ml). Summed per-day for hydration display.
CREATE TABLE IF NOT EXISTS water_logs (
  id           BIGSERIAL PRIMARY KEY,
  telegram_id  BIGINT      NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  logged_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  log_date     DATE        NOT NULL DEFAULT CURRENT_DATE,
  amount_ml    INTEGER     NOT NULL DEFAULT 250
);

CREATE INDEX IF NOT EXISTS idx_water_logs_telegram_date
  ON water_logs(telegram_id, log_date);


-- ── ROW LEVEL SECURITY ────────────────────────────────────────────────────────
-- Enabled for safety. The bot uses the service_role key which bypasses RLS,
-- so this does not affect bot functionality but blocks direct anon access.
ALTER TABLE users      ENABLE ROW LEVEL SECURITY;
ALTER TABLE food_logs  ENABLE ROW LEVEL SECURITY;
ALTER TABLE water_logs ENABLE ROW LEVEL SECURITY;
