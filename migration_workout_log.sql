-- ============================================================
-- WORKOUT LOG MIGRATION — free-text daily training note
-- Run this entire file in Supabase SQL Editor:
--   Dashboard → SQL Editor → New query → Paste → Run
-- ============================================================

-- One row per day (not per entry) — free-text description of what training
-- was done, same overwrite-on-re-entry semantics as weight_logs/steps_logs.
-- Not a workout tracker (no sets/reps/weight structure) — just a record for
-- the weekly export to show training days alongside food/weight/steps.
CREATE TABLE IF NOT EXISTS workout_logs (
  id           BIGSERIAL PRIMARY KEY,
  telegram_id  BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  log_date     DATE   NOT NULL DEFAULT CURRENT_DATE,
  description  TEXT   NOT NULL CHECK (char_length(description) BETWEEN 1 AND 2000),
  logged_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (telegram_id, log_date)
);

CREATE INDEX IF NOT EXISTS idx_workout_logs_telegram_date
  ON workout_logs(telegram_id, log_date);

ALTER TABLE workout_logs ENABLE ROW LEVEL SECURITY;
