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
  cls     TEXT    NOT NULL,          -- class code, e.g. 9B. Boards are per class.
  nick    TEXT    NOT NULL,          -- what the student typed. Free text (SPEC 19.3,
                                     -- revised 2026-08-25), and therefore NEVER shown
                                     -- on a board until a teacher has approved it.
  approved INTEGER NOT NULL DEFAULT 0, -- 0 pending, 1 approved, -1 rejected
  score   INTEGER NOT NULL,
  correct INTEGER NOT NULL,
  wrong   INTEGER NOT NULL,
  chain   INTEGER NOT NULL,          -- longest combo chain in the run
  level   TEXT    NOT NULL,          -- deepest level reached
  created INTEGER NOT NULL           -- unix seconds, server clock not client clock
);

-- The board query: top scores for one class.
CREATE INDEX IF NOT EXISTS idx_runs_board ON runs (cls, score DESC);

-- The rate-limit query: how many runs has this class posted in the last minute.
-- Rate limiting reads this table rather than tracking IP addresses, so that no
-- request metadata has to be stored to make it work.
CREATE INDEX IF NOT EXISTS idx_runs_recent ON runs (cls, created);

-- The moderation queue: everything still waiting on a teacher.
CREATE INDEX IF NOT EXISTS idx_runs_pending ON runs (cls, approved);

-- A name is judged ONCE per class, not once per run. Without this a teacher
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
