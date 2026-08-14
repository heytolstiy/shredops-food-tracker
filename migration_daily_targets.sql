-- ============================================================
-- DAILY TARGETS MIGRATION — freeze calorie/macro targets per day
-- Run this entire file in Supabase SQL Editor:
--   Dashboard → SQL Editor → New query → Paste → Run
-- ============================================================

-- Freezes the calorie/macro target that was active for a given day, so a
-- later change (via /targets or /reset) doesn't silently rewrite how past
-- days are displayed. Written once per user per day by the 23:00 MSK
-- eveningSummary job (scheduler.js) — the last scheduled touchpoint before
-- the day rolls over. "Today" always reads live from `users` instead (the
-- target isn't "closed" yet); only historical reads (/api/logs/:userId/:date)
-- consult this table, falling back to the live `users` row if no snapshot
-- exists yet (e.g. a day before this table existed).
CREATE TABLE IF NOT EXISTS daily_targets (
  id           BIGSERIAL PRIMARY KEY,
  telegram_id  BIGINT  NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  log_date     DATE    NOT NULL DEFAULT CURRENT_DATE,
  calories     INTEGER NOT NULL,
  protein_g    INTEGER NOT NULL,
  fat_g        INTEGER NOT NULL,
  carbs_g      INTEGER NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (telegram_id, log_date)
);

CREATE INDEX IF NOT EXISTS idx_daily_targets_telegram_date
  ON daily_targets(telegram_id, log_date);

ALTER TABLE daily_targets ENABLE ROW LEVEL SECURITY;
