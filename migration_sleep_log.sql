-- ============================================================
-- SLEEP LOG MIGRATION — manual daily hours-of-sleep entry
-- Run this entire file in Supabase SQL Editor:
--   Dashboard → SQL Editor → New query → Paste → Run
-- ============================================================

-- One row per day (not per entry) — manual hours-of-sleep entry, same
-- overwrite-on-re-entry semantics as weight_logs/steps_logs.
CREATE TABLE IF NOT EXISTS sleep_logs (
  id           BIGSERIAL PRIMARY KEY,
  telegram_id  BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  log_date     DATE   NOT NULL DEFAULT CURRENT_DATE,
  hours        NUMERIC(4,2) NOT NULL CHECK (hours BETWEEN 0 AND 24),
  logged_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (telegram_id, log_date)
);

CREATE INDEX IF NOT EXISTS idx_sleep_logs_telegram_date
  ON sleep_logs(telegram_id, log_date);

ALTER TABLE sleep_logs ENABLE ROW LEVEL SECURITY;
