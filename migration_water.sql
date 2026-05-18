-- ============================================================
-- WATER TRACKING MIGRATION — Step 5
-- Run this entire file in Supabase SQL Editor:
--   Dashboard → SQL Editor → New query → Paste → Run
-- ============================================================

-- 1. Add daily water target to users profile
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS target_water_ml INTEGER DEFAULT 2500;

-- 2. Per-drink water log table (one row per 250 ml tap)
CREATE TABLE IF NOT EXISTS water_logs (
  id           BIGSERIAL PRIMARY KEY,
  telegram_id  BIGINT      NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  logged_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  log_date     DATE        NOT NULL DEFAULT CURRENT_DATE,
  amount_ml    INTEGER     NOT NULL DEFAULT 250
);

CREATE INDEX IF NOT EXISTS idx_water_logs_telegram_date
  ON water_logs(telegram_id, log_date);

ALTER TABLE water_logs ENABLE ROW LEVEL SECURITY;
