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
  cls     TEXT    NOT NULL,          -- THE YEAR GROUP since v0.50 (SPEC 60): Y7, Y8,
                                     -- Y9, KS4, OTHER, and ALL for everything posted
                                     -- before year groups existed. This column was
                                     -- kept rather than dropped when the app went to
                                     -- one shared board, with a note saying per-class
                                     -- boards could return without a migration: this
                                     -- is that. A name is judged once per cls and the
                                     -- board shows one line per (cls, nick), which is
                                     -- exactly what a year group needs, so no second
                                     -- column was added.
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
  board   TEXT    NOT NULL DEFAULT 'wc', -- which challenge (SPEC 50). On a database
                                     -- made before v0.39 the worker adds this column
                                     -- itself on the first request; see
                                     -- ensureBoardColumn(). Its index is made there
                                     -- too, for the same reason.
  ver     TEXT    NOT NULL DEFAULT ''   -- the app version this run was posted from
                                     -- (v0.58), shown beside a record in the hall of
                                     -- fame. Empty on everything posted before v0.58,
                                     -- which is the truth rather than a gap. Added to
                                     -- an existing database by ensureBoardColumn(),
                                     -- exactly as `board` was.
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

-- THE CYCLE (v0.58, SPEC 68). Michael's school runs a two-week timetable and he
-- rewards the top of each skill and year group every cycle, so the student board
-- shows the current cycle only and empties at local midnight between Sunday and
-- Monday. Boundaries are ROWS rather than arithmetic on an offset: a cycle that
-- has happened is a fact about the past, and if the bounds were computed from an
-- anchor then moving the anchor would move history and rewrite who won cycle 3.
--
-- Rows are created lazily, by the first request after a boundary passes; nothing
-- here runs on a timer. A run is not stamped with its cycle, because `created`
-- already says which one it falls in.
--
-- The worker creates this itself on the first request too (ensureCycleTable), so
-- a database made before v0.58 needs nothing done to it.
CREATE TABLE IF NOT EXISTS cycles (
  n       INTEGER PRIMARY KEY AUTOINCREMENT,
  start   INTEGER NOT NULL,          -- unix seconds. A Monday 00:00 in Phuket (UTC+7).
  end     INTEGER NOT NULL           -- normally start + 14 days. SHORTER when a
                                     -- one-week break moved the timetable and a
                                     -- teacher said so on /admin/cycle: the cycle in
                                     -- progress is closed early and a new one opens,
                                     -- which is what a break does to a timetable.
);
