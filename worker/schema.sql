-- Word Class Commando leaderboard. SPEC section 19.
--
-- What is deliberately NOT here, and must not be added without amending
-- SPEC 19.3: real names, school identifiers, IP addresses, misconception
-- counters, anything at all from practice or test mode. This table holds
-- challenge-mode runs and nothing else.
--
-- Idempotent: safe to run again on every deploy.

CREATE TABLE IF NOT EXISTS runs (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  cls     TEXT    NOT NULL,          -- ONE shared board since 2026-08-25 (SPEC 30):
                                     -- runs land under ALL unless a code is sent.
                                     -- Kept, not dropped, so per-class boards can
                                     -- return without a migration.
  nick    TEXT    NOT NULL,          -- what the student typed. Free text (SPEC 19.3,
                                     -- revised 2026-08-25), and therefore NEVER shown
                                     -- on a board until a teacher has approved it.
  approved INTEGER NOT NULL DEFAULT 0, -- 0 pending, 1 approved, -1 rejected
  score   INTEGER NOT NULL,
  correct INTEGER NOT NULL,
  wrong   INTEGER NOT NULL,
  chain   INTEGER NOT NULL,          -- longest combo chain in the run
  level   TEXT    NOT NULL,          -- deepest level reached in the run (v0.45; before
                                     -- that, the level when the clock ran out)
  created INTEGER NOT NULL,          -- unix seconds, server clock not client clock
  board   TEXT    NOT NULL DEFAULT 'wc'  -- which challenge (SPEC 50). On a database
                                     -- made before v0.39 the worker adds this column
                                     -- itself on the first request; see
                                     -- ensureBoardColumn(). Its index is made there
                                     -- too, for the same reason.
);

-- Older indexes from the per-class design. Kept (they cost nothing); the hot
-- queries since the one shared board are served by the two below and by
-- idx_runs_kind (board, score DESC), which the worker creates itself.
CREATE INDEX IF NOT EXISTS idx_runs_board ON runs (cls, score DESC);
CREATE INDEX IF NOT EXISTS idx_runs_recent ON runs (cls, created);
CREATE INDEX IF NOT EXISTS idx_runs_pending ON runs (cls, approved);

-- The rate-limit query: how many runs in the last minute, app-wide. Rate
-- limiting reads this table rather than tracking IP addresses, so that no
-- request metadata has to be stored to make it work.
CREATE INDEX IF NOT EXISTS idx_runs_created ON runs (created);

-- The moderation queue: everything still waiting on a teacher, grouped by name.
CREATE INDEX IF NOT EXISTS idx_runs_waiting ON runs (approved, cls, nick);

-- A name is judged ONCE per class, not once per run, and "Rude", "RUDE" and
-- "R u d e" are one name: the worker compares lower-case with spaces removed. Without this a teacher
-- approves the same thirty names every lesson, which is how a moderation queue
-- stops being used. A decision here is applied to that student's future runs
-- automatically, and retrospectively to any of theirs still pending.
CREATE TABLE IF NOT EXISTS names (
  cls     TEXT    NOT NULL,
  nick    TEXT    NOT NULL,
  status  INTEGER NOT NULL,          -- 1 approved, -1 rejected
  decided INTEGER NOT NULL,
  PRIMARY KEY (cls, nick)
);
