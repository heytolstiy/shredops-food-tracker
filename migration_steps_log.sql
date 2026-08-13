-- ============================================================
-- STEPS LOG MIGRATION — manual daily step count
-- Run this entire file in Supabase SQL Editor:
--   Dashboard → SQL Editor → New query → Paste → Run
-- ============================================================

-- One row per day (not per entry) — manual daily step count, same
-- overwrite-on-re-entry semantics as weight_logs, unlike the additive
-- water_logs.
CREATE TABLE IF NOT EXISTS steps_logs (
  id           BIGSERIAL PRIMARY KEY,
  telegram_id  BIGINT      NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  log_date     DATE        NOT NULL DEFAULT CURRENT_DATE,
  steps        INTEGER     NOT NULL CHECK (steps BETWEEN 0 AND 200000),
  logged_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (telegram_id, log_date)
);

CREATE INDEX IF NOT EXISTS idx_steps_logs_telegram_date
  ON steps_logs(telegram_id, log_date);

ALTER TABLE steps_logs ENABLE ROW LEVEL SECURITY;
