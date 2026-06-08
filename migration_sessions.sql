-- ============================================================
-- MIGRATION: Add persistent bot session store
-- Run this on any existing Supabase project that already has
-- the base schema from database.sql.
--
-- Steps:
--   1. Open Supabase project dashboard
--   2. SQL Editor → New query
--   3. Paste this file and click Run
-- ============================================================

CREATE TABLE IF NOT EXISTS bot_sessions (
  session_key  TEXT PRIMARY KEY,
  session_data JSONB NOT NULL DEFAULT '{}',
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE bot_sessions ENABLE ROW LEVEL SECURITY;
