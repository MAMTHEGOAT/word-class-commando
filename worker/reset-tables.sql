-- ============================================================
--  DESTRUCTIVE. Deletes every score on the leaderboard.
-- ============================================================
--
-- Run this ONCE, on 2026-08-25, to move the deployed database from the
-- generated-nickname design to the moderated free-text one (SPEC 19.3 as
-- revised). The `runs` table gained an `approved` column and a `names` table
-- appeared beside it, and `CREATE TABLE IF NOT EXISTS` cannot add a column to
-- a table that already exists.
--
-- This is safe RIGHT NOW and only right now, because the board has never held
-- a real score: it was verified empty immediately after deployment. Once
-- students have played, this file must not be run again, and a schema change
-- needs a real migration that preserves rows instead.
--
--   npx wrangler d1 execute wcc-board --remote --file=./reset-tables.sql
--   deploy-worker.bat          (recreates the tables from schema.sql)

DROP TABLE IF EXISTS runs;
DROP TABLE IF EXISTS names;
