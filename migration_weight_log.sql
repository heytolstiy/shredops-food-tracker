-- ============================================================
-- WEIGHT LOG MIGRATION — editable daily weigh-in
-- Run this entire file in Supabase SQL Editor:
--   Dashboard → SQL Editor → New query → Paste → Run
-- ============================================================

-- One row per day (not per entry). Re-recording the same day overwrites the
-- value via UNIQUE(telegram_id, log_date) + upsert — the app never duplicates
-- a day's weigh-in.
CREATE TABLE IF NOT EXISTS weight_logs (
  id           BIGSERIAL PRIMARY KEY,
  telegram_id  BIGINT      NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  log_date     DATE        NOT NULL DEFAULT CURRENT_DATE,
  weight_kg    NUMERIC(5,2) NOT NULL CHECK (weight_kg BETWEEN 20 AND 300),
  logged_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (telegram_id, log_date)
);

CREATE INDEX IF NOT EXISTS idx_weight_logs_telegram_date
  ON weight_logs(telegram_id, log_date);

ALTER TABLE weight_logs ENABLE ROW LEVEL SECURITY;
