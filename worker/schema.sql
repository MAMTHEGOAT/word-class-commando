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
  nick    TEXT    NOT NULL,          -- composed BY THE WORKER from two word lists,
                                     -- never free text from the client (SPEC 19.3)
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
