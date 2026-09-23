/**
 * Word Class Commando: the leaderboard service.
 * Governed by SPEC section 19. Read it before changing anything here.
 *
 * The three rules that shaped this file:
 *
 *  1. The APP must work with this unreachable (SPEC 19.2). Nothing here is
 *     allowed to become load-bearing. If this service is down, the game still
 *     runs and still keeps a personal best locally. That is enforced on the
 *     client, but it is why this file may stay this small.
 *
 *  2. Scores cannot be trusted and that is unfixable (SPEC 19.4). The run
 *     happens in a browser and the source is public. So this rejects the
 *     IMPOSSIBLE rather than pretending to verify the plausible: arithmetic
 *     that could not have happened, more items than the run's time allows, a
 *     chain longer than the correct answers. Everything past that is a social
 *     problem, and in a class of thirty a social problem is manageable.
 *
 *  3. Nicknames are FREE TEXT and therefore MODERATED (SPEC 19.3, revised
 *     2026-08-25). An earlier version of this file composed them from word
 *     lists so that a rude name was structurally impossible; the teacher
 *     ruled that students should choose their own. The safety property moved
 *     from "cannot be typed" to "cannot be SEEN until approved": the public
 *     board route never returns an unapproved name, and the score ranks
 *     immediately while the name waits. A blocklist was considered instead
 *     and rejected, because it loses the arms race within a week.
 *
 * Not stored, ever: real names, school identifiers, IP addresses, misconception
 * counters, anything from practice or test mode.
 */

/* Nicknames are FREE TEXT, and therefore moderated (SPEC 19.3, revised
   2026-08-25 on the teacher's ruling, reversing the generated-name design).

   The safety property is not a filter, it is a gate: a name NEVER leaves this
   worker on the public board route until a teacher has approved it. A blocklist
   was considered and rejected, because it loses the arms race to spacing and
   spelling within a week and produces false positives on ordinary words.

   A name is judged once per class, not once per run: see the `names` table.
   Without that, a teacher approves the same thirty names every lesson, which is
   how a moderation queue stops being used. */
const NICK_MAX = 16;

/** Clean a submitted nickname, or return null if nothing usable is left.
 *  Cleaning is about making the value SAFE TO STORE AND DISPLAY, not about
 *  judging it. The judging is a person's job and happens later. */
function cleanNick(v) {
  if (typeof v !== "string") return null;
  let s = v.normalize("NFKC")                         // fullwidth and look-alike forms
           .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")  // control characters
           /* zero-width, direction overrides, word joiners, BOM: invisible, so a
              "name" of nothing but these reached the queue as a blank card */
           .replace(/[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, "")
           .replace(/[<>]/g, "")                       // never worth storing
           .replace(/\s+/g, " ")
           .trim();
  if (!s) return null;
  if ([...s].length > NICK_MAX) return null;
  return s;
}

/* One name, however it is typed. "Rude", "RUDE" and "R u d e" are one decision
   and one line on the board (audit 2026-09-22). Done IN SQL on both sides of every
   comparison, so the stored display form never has to change and old rows fold
   exactly as new ones do. cleanNick has already turned every space into " ". */
const FOLD = (col) => "lower(replace(" + col + ", ' ', ''))";

const LEVELS = ["foundation", "developing", "secure", "challenge"];

/* The boards (SPEC 50). One per discipline plus the Ultimate Champion, each with
   its own run length, which is what the physical bounds below are computed from.
   A run with no board is a Word classes run: that is every run posted before
   v0.39, and every run from an app that has not been updated yet. */
const BOARDS = { wc: 60, punc: 120, tense: 120, tech: 120, texp: 120, ult: 240 };
const DEFAULT_KIND = "wc";

/* Physical bounds for a run. Deliberately generous: this is here to reject
   999999, not to second-guess a fast student. */
const MIN_MS_PER_ITEM = 350;                                  // faster than a human reads
function maxItems(board) { return Math.floor((BOARDS[board] * 1000) / MIN_MS_PER_ITEM); }

/* The board column arrived after the database did. D1 has no "ADD COLUMN IF NOT
   EXISTS", and deploy-worker.bat re-runs schema.sql on every deploy, so the
   column is added here, once per worker instance, and the "duplicate column"
   error that every later attempt raises is the sign it is already done. The
   index is made here too, because schema.sql runs BEFORE any request and so
   before the column can exist on an old database. */
let boardColumnReady = false;
async function ensureBoardColumn(env) {
  if (boardColumnReady) return;
  try {
    await env.DB.prepare("ALTER TABLE runs ADD COLUMN board TEXT NOT NULL DEFAULT 'wc'").run();
  } catch (e) {
    if (!/duplicate column/i.test(String(e && e.message || e))) throw e;
  }
  /* The app version a record was set on (v0.58), for the hall of fame. Added
     the same way and for the same reason as `board`. It is empty on every run
     posted before v0.58, which is correct rather than unfortunate: those records
     were set on a version nobody wrote down. */
  try {
    await env.DB.prepare("ALTER TABLE runs ADD COLUMN ver TEXT NOT NULL DEFAULT ''").run();
  } catch (e) {
    if (!/duplicate column/i.test(String(e && e.message || e))) throw e;
  }
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_runs_kind ON runs (board, score DESC)").run();
  /* The cycle board asks for one fortnight of one board, which without this is
     a scan of the whole table on every load of the leaderboard. */
  await env.DB.prepare(
    "CREATE INDEX IF NOT EXISTS idx_runs_when ON runs (board, created, score DESC)").run();
  boardColumnReady = true;
}

/* The app version, as a label and nothing more. It is shown next to a record in
   the hall of fame, so it is cleaned exactly as hard as a class code and no
   harder: anything unexpected becomes no version rather than a bad request,
   because a run must never be refused over a cosmetic field. */
function cleanVer(v) {
  if (typeof v !== "string") return "";
  const s = v.trim();
  return /^v[0-9]{1,3}\.[0-9]{1,3}$/.test(s) ? s : "";
}

function cleanKind(v) {
  if (v === undefined || v === null || v === "") return DEFAULT_KIND;
  return (typeof v === "string" && Object.prototype.hasOwnProperty.call(BOARDS, v)) ? v : null;
}
const MAX_MULTIPLIER = 5;        // combo multiplier ceiling, mirrored in the app
const WRONG_PENALTY = 3;
const SCORE_FLOOR = -5;          // the running floor, mirrored in the app (SPEC 31)

/* Rate limit, measured off the runs table so that no request metadata (IP,
   headers, fingerprint) has to be stored to make it work. */
const RATE_WINDOW_SECONDS = 60;
/* There is ONE board now (2026-08-25), so this ceiling is no longer per class:
   it is the whole app. A run takes sixty seconds, so a student cannot post more
   than once a minute, and a class of thirty is thirty. Set for several classes
   playing at once with room to spare, because a limit that throttles a real
   lesson is worse than one that lets a script through: the script is answered
   by the Remove button and the moderation queue, a stuck lesson is not. */
const RATE_MAX_PER_WINDOW = 240;

/* Every run lands here unless a year group is explicitly given. This is now
   the bucket for runs posted BEFORE v0.50, when nothing was asked, and for a
   run from an app that has not been updated yet. The teacher moves a name out
   of it with /admin/assign. */
const DEFAULT_BOARD = "ALL";

/* YEAR GROUPS (v0.50, Michael). The `cls` column was kept rather than dropped
   when the app went to one shared board, with a note saying per-class boards
   could return without a migration. This is that moment, and the column is
   reused rather than a second one added, because everything that has to be true
   of a year group is already true of `cls`:
     - a name is judged once per cls (the `names` table), so a Year 7 Dragon and
       a Year 9 Dragon are two people needing two approvals, which is Michael's
       ruling;
     - the board's one-line-per-name window partitions by (cls, nick), so both
       Dragons appear on the all-years board, each at their own best;
     - /board already filters by cls, so the year filter needs no new route.
   A second column would have had to reproduce all three.

   The list is closed. The app is the only thing that posts, and an open field
   would let a typo quietly create a sixth year group that nobody can see is
   wrong. ALL is accepted because old rows and old app versions carry it. */
const YEARS = ["Y7", "Y8", "Y9", "KS4", "OTHER"];
function isYear(v) { return YEARS.indexOf(v) >= 0 || v === DEFAULT_BOARD; }

const BOARD_DEFAULT = 20;
const BOARD_MAX = 100;

/* ============================== THE CYCLE (v0.58) ==========================
 * Michael's school runs a two-week timetable and he rewards the top of each
 * skill and year group at the end of every cycle. So the student board is the
 * CURRENT cycle only, and it empties at local midnight between the Sunday and
 * the Monday. Past cycles are the teacher's, behind the key.
 *
 * Three things this design refuses to do:
 *
 *  1. It does not compute a cycle from an offset. Cycle boundaries are ROWS, in
 *     a table, created as time passes. A cycle that has happened is a fact about
 *     the past, and the moment a boundary is computed from "the anchor plus n
 *     times fourteen days", moving the anchor moves history, which would quietly
 *     rewrite who won cycle 3.
 *
 *  2. It does not store a cycle number on a run. `created` already says which
 *     cycle a run belongs to, and a stored number would need backfilling the
 *     first time a boundary moved.
 *
 *  3. It does not use the server's timezone. Cloudflare runs in UTC and
 *     Michael's midnight is seven hours earlier, so the offset is written down
 *     rather than inherited. Thailand has no daylight saving, which is the one
 *     thing that makes a fixed offset honest here.
 *
 * A one-week break offsets the real timetable, so /admin/cycle lets a teacher
 * say "this week is Week A" or "this week is Week B". That CLOSES the cycle in
 * progress at the new boundary and opens a new one, which is what a break
 * actually does: it interrupts the cycle rather than renumbering the year.
 */
const TZ_OFFSET = 7 * 3600;              // Asia/Bangkok. No daylight saving.
const DAY = 86400;
const CYCLE_SECONDS = 14 * DAY;
/* Cycle 1 begins Monday 14 September 2026, 00:00 in Phuket. Michael, 2026-09-23:
   "this week is Week B" and "today is day 8", on Wednesday 23 September, which
   puts day 1 on Monday 14 September and the first reset at midnight Sunday 27
   into Monday 28 September. */
const CYCLE_ANCHOR = Date.UTC(2026, 8, 13, 17, 0, 0) / 1000;

/** The Monday 00:00 (local) of the week containing `ts`, as a real timestamp. */
function localMonday(ts) {
  const day = Math.floor((ts + TZ_OFFSET) / DAY);   // days since epoch, locally
  const dow = (day + 4) % 7;                        // 1970-01-01 was a Thursday
  return (day - ((dow + 6) % 7)) * DAY - TZ_OFFSET;
}

let cycleTableReady = false;
async function ensureCycleTable(env) {
  if (cycleTableReady) return;
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS cycles (n INTEGER PRIMARY KEY AUTOINCREMENT, " +
    "start INTEGER NOT NULL, end INTEGER NOT NULL)").run();
  cycleTableReady = true;
}

/** The cycle containing `now`, creating any that have elapsed since the last
 *  request. Cycles roll forward lazily because nothing here runs on a timer:
 *  the first request after a Monday midnight is what closes Sunday's cycle. */
async function currentCycle(env, now) {
  await ensureCycleTable(env);
  let row = await env.DB.prepare("SELECT n, start, end FROM cycles ORDER BY n DESC LIMIT 1").first();
  if (!row) {
    await env.DB.prepare("INSERT INTO cycles (start, end) VALUES (?, ?)")
      .bind(CYCLE_ANCHOR, CYCLE_ANCHOR + CYCLE_SECONDS).run();
    row = await env.DB.prepare("SELECT n, start, end FROM cycles ORDER BY n DESC LIMIT 1").first();
  }
  /* Bounded: a worker asleep for a term rolls a term's worth, and the loop stops
     at a hundred rather than running until the request times out. */
  let guard = 0;
  while (row.end <= now && guard++ < 100) {
    await env.DB.prepare("INSERT INTO cycles (start, end) VALUES (?, ?)")
      .bind(row.end, row.end + CYCLE_SECONDS).run();
    row = await env.DB.prepare("SELECT n, start, end FROM cycles ORDER BY n DESC LIMIT 1").first();
  }
  return row;
}

/** Where in the cycle today is: Week A or B, and the school day 1 to 10.
 *  A weekend has no day number, because the timetable has no day there. */
function cyclePlace(start, now) {
  const d = Math.floor((now + TZ_OFFSET) / DAY) - Math.floor((start + TZ_OFFSET) / DAY);
  if (d < 0 || d > 13) return { week: null, day: null, weekend: false, index: d };
  const inWeek = d % 7;                                  // 0 Monday .. 6 Sunday
  return {
    week: d < 7 ? "A" : "B",
    day: inWeek <= 4 ? (d < 7 ? inWeek + 1 : inWeek + 6) : null,
    weekend: inWeek > 4,
    index: d
  };
}

/** What every caller is told about the cycle. `now` travels with it so a device
 *  with a wrong clock still counts down to the right moment. */
function cycleState(row, now) {
  const place = cyclePlace(row.start, now);
  return {
    cycle: row.n, start: row.start, end: row.end, now: now,
    week: place.week, day: place.day, weekend: place.weekend,
    resetIn: Math.max(0, row.end - now), tz: TZ_OFFSET
  };
}

/* ------------------------------------------------------------------ helpers */

function cors(env, extra) {
  const h = {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Teacher-Key",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
  return Object.assign(h, extra || {});
}

function json(env, body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: cors(env, { "Content-Type": "application/json; charset=utf-8" })
  });
}

function isInt(v, lo, hi) {
  return typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
}

/** Class codes are a label on a board, not a secret. Keep them boring so they
 *  cannot smuggle anything into a page that renders them. */
function cleanClass(v) {
  if (typeof v !== "string") return null;
  const s = v.trim().toUpperCase();
  return /^[A-Z0-9]{1,8}$/.test(s) ? s : null;
}

/**
 * The best score that COULD have been achieved with this many correct answers,
 * this many wrong ones, and this longest chain.
 *
 * The app's scoring is: each correct answer scores 1 x the current multiplier,
 * where the multiplier climbs with the chain and caps at MAX_MULTIPLIER; each
 * wrong answer costs WRONG_PENALTY and resets the chain.
 *
 * We cannot know the real order of events, so we assume the most generous one:
 * every correct answer scored at the cap. Anything above that did not happen.
 * This is intentionally loose. It is a sanity bound, not a recomputation, and
 * pretending otherwise would be the "verify the plausible" trap of SPEC 19.4.
 */
function maxPossibleScore(correct, wrong) {
  /* The app floors the RUNNING total at SCORE_FLOOR (SPEC 31), so wrong answers
     taken at the floor cost nothing and at most |SCORE_FLOOR| is ever lost to
     them. Before v0.45 this subtracted every wrong answer in full, and an honest
     run of twelve wrong then ten right (17) was refused as impossible (14). */
  return correct * MAX_MULTIPLIER - Math.min(wrong * WRONG_PENALTY, -SCORE_FLOOR);
}

/* ----------------------------------------------------------------- handlers */

async function postScore(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json(env, { error: "bad json" }, 400);
  }

  /* The year group. Optional on the wire, because an app from before v0.50 does
     not send one and its runs must still land somewhere; required in the app,
     which is where a pupil can be asked. */
  let cls = DEFAULT_BOARD;
  if (body.cls !== undefined && body.cls !== null && String(body.cls).trim() !== "") {
    cls = cleanClass(body.cls);
    if (!cls || !isYear(cls)) return json(env, { error: "bad year group" }, 400);
  }

  const nick = cleanNick(body.nick);
  if (!nick) return json(env, { error: "bad nickname" }, 400);

  const board = cleanKind(body.board);
  if (!board) return json(env, { error: "bad board" }, 400);
  const MAX_ITEMS = maxItems(board);

  const correct = body.correct, wrong = body.wrong, chain = body.chain, score = body.score;

  if (!isInt(correct, 0, MAX_ITEMS)) return json(env, { error: "bad correct" }, 400);
  if (!isInt(wrong, 0, MAX_ITEMS)) return json(env, { error: "bad wrong" }, 400);
  if (!isInt(chain, 0, correct)) return json(env, { error: "chain longer than correct answers" }, 400);
  if (correct + wrong > MAX_ITEMS)
    return json(env, { error: "more items than the run allows" }, 400);
  if (typeof body.level !== "string" || LEVELS.indexOf(body.level) < 0)
    return json(env, { error: "bad level" }, 400);
  if (!isInt(score, -(MAX_ITEMS * WRONG_PENALTY), MAX_ITEMS * MAX_MULTIPLIER))
    return json(env, { error: "bad score" }, 400);
  if (score > maxPossibleScore(correct, wrong))
    return json(env, { error: "score impossible for that many answers" }, 400);

  /* A run has to be worth something to go on the board (2026-08-25). Students
     found it funny to race each other for the WORST possible score, which is a
     second leaderboard running the other way and an easier one to win.
     It is refused here rather than only in the app, because the board is public
     and a client-side rule is a suggestion. Note what this does NOT do: the app
     still shows the student their real negative score, because a bad run saying
     so loudly is the feedback the penalty exists for (SPEC 24). What is removed
     is the audience for it, which is the part that made tanking fun. */
  if (score < 0)
    return json(env, { error: "a run has to finish on zero or better" }, 400);

  const now = Math.floor(Date.now() / 1000);
  await ensureBoardColumn(env);

  /* Rate limit off the table itself. See the note by RATE_WINDOW_SECONDS. */
  const recent = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM runs WHERE created > ?")
    .bind(now - RATE_WINDOW_SECONDS)
    .first();
  if (recent && recent.n >= RATE_MAX_PER_WINDOW)
    return json(env, { error: "too many scores just now" }, 429);

  /* Has this name already been judged for this class? If so the decision
     carries over, so a student who has been approved once is not re-queued
     every single run. */
  const prior = await env.DB
    .prepare("SELECT status FROM names WHERE cls = ? AND " + FOLD("nick") + " = " + FOLD("?") +
             " ORDER BY decided DESC LIMIT 1")
    .bind(cls, nick)
    .first();
  const approved = prior ? prior.status : 0;

  await env.DB
    .prepare(
      "INSERT INTO runs (cls, nick, approved, score, correct, wrong, chain, level, created, board, ver) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(cls, nick, approved, score, correct, wrong, chain, body.level, now, board, cleanVer(body.ver))
    .run();

  /* Which cycle this landed in. The ranks below are counted INSIDE it, because
     that is the board the pupil is about to look at: telling a pupil they are
     fourth of an all-time list they cannot see would be answering a question
     nobody asked (v0.58). */
  const cyc = await currentCycle(env, now);
  const CYC = " AND created >= " + cyc.start + " AND created < " + cyc.end + " ";

  /* Tell the student where they landed, counted exactly as the public board
     counts: one line per name.

     TWO ranks since v0.50, because there are now two boards a pupil cares about
     and the app opens on the first of them: the all-years board is the headline
     and is never filtered here, and the year rank is the one they can realistically
     win. Before v0.50 sending a class code silently made the ONLY rank a within-class
     one, which would have quietly changed what every pupil was told the moment
     the year group became required. */
  const rank = await env.DB
    .prepare("SELECT COUNT(DISTINCT cls || '|' || " + FOLD("nick") + ") AS n FROM runs " +
             "WHERE board = ? AND score > ? AND NOT (cls = ? AND " + FOLD("nick") + " = " + FOLD("?") + ")" + CYC)
    .bind(board, score, cls, nick)
    .first();
  const yrRank = await env.DB
    .prepare("SELECT COUNT(DISTINCT " + FOLD("nick") + ") AS n FROM runs " +
             "WHERE board = ? AND cls = ? AND score > ? AND " + FOLD("nick") + " <> " + FOLD("?") + CYC)
    .bind(board, cls, score, nick)
    .first();
  /* Two bests, and they answer different questions. The CYCLE best is the line
     this pupil has on the board they can see; the ALL-TIME best is the one the
     hall of fame holds and the one it would take a personal record to beat. */
  const mine = await env.DB
    .prepare("SELECT MAX(score) AS best FROM runs WHERE board = ? AND cls = ? AND " +
             FOLD("nick") + " = " + FOLD("?") + CYC)
    .bind(board, cls, nick)
    .first();
  const ever = await env.DB
    .prepare("SELECT MAX(score) AS best FROM runs WHERE board = ? AND cls = ? AND " +
             FOLD("nick") + " = " + FOLD("?"))
    .bind(board, cls, nick)
    .first();
  const best = mine && typeof mine.best === "number" ? mine.best : score;
  const allBest = ever && typeof ever.best === "number" ? ever.best : score;
  /* Did this run take the all-time record on this board? The hall of fame is
     public, so this is checked against every year group and not only this one. */
  const held = await env.DB
    .prepare("SELECT MAX(score) AS top FROM runs WHERE board = ?")
    .bind(board)
    .first();

  return json(env, { ok: true, nick: nick, approved: approved, board: board,
                     cls: cls, years: YEARS,
                     rank: (rank ? rank.n : 0) + 1,
                     yearRank: (yrRank ? yrRank.n : 0) + 1,
                     isBest: score >= best, best: best,
                     allBest: allBest,
                     record: !!(held && typeof held.top === "number" && score >= held.top),
                     cycle: cycleState(cyc, now) });
}

/** The board. `cls` is OPTIONAL: with none given this is the one shared board
 *  across everything, which is what the app asks for. A code still filters, so
 *  rows posted under one before 2026-08-25 are neither lost nor stranded. */
async function getBoard(url, env) {
  const raw = url.searchParams.get("cls");
  let cls = null;
  if (raw !== null && raw.trim() !== "") {
    cls = cleanClass(raw);
    if (!cls || !isYear(cls)) return json(env, { error: "bad year group" }, 400);
  }

  const board = cleanKind(url.searchParams.get("board"));
  if (!board) return json(env, { error: "bad board" }, 400);

  let limit = parseInt(url.searchParams.get("limit") || "", 10);
  if (!Number.isInteger(limit) || limit < 1) limit = BOARD_DEFAULT;
  if (limit > BOARD_MAX) limit = BOARD_MAX;

  /* TWO public boards since v0.58, and only two. `scope=cycle` (the default) is
     the fortnight running now, which is the one students compete on; `scope=all`
     is the hall of fame, every score ever set on this board.
     What this route deliberately does NOT accept is a cycle NUMBER. Students see
     the cycle they are in and the all-time records, and nothing else; a past
     cycle is the teacher's, behind the key, on /admin/cycles. That is a property
     of the route rather than of the app, for the same reason an unapproved name
     is (SPEC 19.3): a rule the client enforces is a rule anybody can edit. */
  const scope = url.searchParams.get("scope") || "cycle";
  if (scope !== "cycle" && scope !== "all") return json(env, { error: "bad scope" }, 400);

  await ensureBoardColumn(env);
  const now = Math.floor(Date.now() / 1000);
  const cyc = await currentCycle(env, now);
  const WHEN = scope === "cycle"
    ? " AND created >= " + cyc.start + " AND created < " + cyc.end + " " : " ";

  /* ONE line per name: each name's best run on this board (v0.45). Before, one
     keen pupil could fill the whole top five with their own history. */
  const sql =
    "SELECT id, cls, nick, approved, score, correct, wrong, chain, level, created, ver FROM (" +
    "SELECT *, ROW_NUMBER() OVER (PARTITION BY cls, " + FOLD("nick") +
    " ORDER BY score DESC, created ASC) AS rn FROM runs " +
    "WHERE board = ? " + (cls ? "AND cls = ? " : "") + WHEN +
    ") WHERE rn = 1 ORDER BY score DESC, created ASC LIMIT ?";
  const rows = await (cls ? env.DB.prepare(sql).bind(board, cls, limit)
                          : env.DB.prepare(sql).bind(board, limit)).all();

  /* THE safety property of the whole moderation design: an unapproved name does
     not leave this worker on the public route. Not masked on the client, not
     filtered in the app, not sent at all. The score still ranks, because holding
     the score hostage to a teacher's attention would make the board useless. */
  const out = ((rows && rows.results) || []).map(function (r) {
    const out = {
      id: r.id, score: r.score, correct: r.correct, wrong: r.wrong,
      chain: r.chain, level: r.level, created: r.created,
      status: r.approved,
      /* The year group travels with the row (v0.50) so the all-years board can
         show which year a score came from. It is a bucket of tens of pupils, not
         an identifier of one, and it is the label the board is being filtered by:
         SPEC 19.3 amended to say so rather than left to be inferred. */
      cls: r.cls,
      /* The hall of fame says when a record was set and on which version of the
         app. Empty on anything posted before v0.58, which is the truth. */
      ver: r.ver || ""
    };
    if (r.approved === 1) out.nick = r.nick;
    return out;
  });

  /* Which year filters have anything behind them, so the app can offer the ones
     that exist instead of five chips leading to four empty boards. Counted on
     this board only, because a year can be busy on Word classes and empty on
     Ultimate Champion, and within THIS scope, because a year that played last
     term is not a year with a chip on this fortnight's board. */
  const seen = await env.DB
    .prepare("SELECT DISTINCT cls FROM runs WHERE board = ?" + WHEN)
    .bind(board)
    .all();
  const years = ((seen && seen.results) || []).map(function (r) { return r.cls; });

  return json(env, { cls: cls, kind: board, scope: scope, board: out,
                     years: years, allYears: YEARS,
                     cycle: cycleState(cyc, now) });
}

/** Teacher routes. One shared secret, set with `wrangler secret put TEACHER_KEY`.
 *  If the secret was never set, these refuse rather than defaulting to open. */
/** Distinguishes "no key is configured on this worker" from "wrong key".
 *  Returns "ok", "wrong", or "unset".
 *
 *  Telling the caller the secret was never set leaks nothing useful: it says
 *  the route is unusable, not what would make it usable. It is worth saying
 *  because the alternative is a teacher hunting for a password that does not
 *  exist, told by their own app that the one they have is wrong. */
function teacherState(request, env) {
  if (!env.TEACHER_KEY) return "unset";
  return teacherOk(request, env) ? "ok" : "wrong";
}

function teacherOk(request, env) {
  if (!env.TEACHER_KEY) return false;
  const given = request.headers.get("X-Teacher-Key") || "";
  if (given.length !== env.TEACHER_KEY.length) return false;
  /* Constant-time-ish compare. The value is a shared classroom secret rather
     than a password hash, but there is no reason to leak its length by timing. */
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ env.TEACHER_KEY.charCodeAt(i);
  return diff === 0;
}

async function adminDelete(request, env) {
  const auth = teacherState(request, env);
  if (auth !== "ok")
    return json(env, { error: auth === "unset" ? "no key set" : "no" }, 403);
  let body;
  try { body = await request.json(); } catch (e) { return json(env, { error: "bad json" }, 400); }
  if (!isInt(body.id, 1, Number.MAX_SAFE_INTEGER)) return json(env, { error: "bad id" }, 400);
  const r = await env.DB.prepare("DELETE FROM runs WHERE id = ?").bind(body.id).run();
  return json(env, { ok: true, deleted: (r.meta && r.meta.changes) || 0 });
}

/** Everything still waiting on a person.
 *
 *  `cls` is OPTIONAL and is only a filter. The teacher key is what authorises
 *  this route, and a teacher does not necessarily know which class a name was
 *  posted under: making them guess it is asking them for something the server
 *  already knows. With no class given this returns every pending name across
 *  every class, each row carrying its own.
 *
 *  Note this is NOT how /admin/clear behaves. Deleting one board is a thing you
 *  should have to name. */
async function adminPending(request, env) {
  const auth = teacherState(request, env);
  if (auth !== "ok")
    return json(env, { error: auth === "unset" ? "no key set" : "no" }, 403);
  let body;
  try { body = await request.json(); } catch (e) { return json(env, { error: "bad json" }, 400); }

  let cls = null;
  if (body.cls !== undefined && body.cls !== null && String(body.cls).trim() !== "") {
    cls = cleanClass(body.cls);
    if (!cls) return json(env, { error: "bad class code" }, 400);
  }

  /* Grouped by name WITHIN a class, because a name is judged per class: the
     teacher is judging NAMES, not runs, so a student who has played six times
     is one decision rather than six. */
  /* ONE queue for every board (SPEC 50): a name is judged once and the decision
     covers every board it plays on, so the teacher never visits six queues.
     `boards` only tells the teacher where the name has been seen. */
  await ensureBoardColumn(env);
  const sql =
    "SELECT cls, MIN(nick) AS nick, COUNT(*) AS runs, MAX(score) AS best, MIN(created) AS first, " +
    "GROUP_CONCAT(DISTINCT board) AS boards " +
    "FROM runs WHERE approved = 0 " + (cls ? "AND cls = ? " : "") +
    "GROUP BY cls, " + FOLD("nick") + " ORDER BY first ASC LIMIT 200";
  const stmt = cls ? env.DB.prepare(sql).bind(cls) : env.DB.prepare(sql);
  const rows = await stmt.all();
  return json(env, { cls: cls, pending: (rows && rows.results) || [] });
}

/** Approve or reject a NAME for a class, which decides every run that name has
 *  posted and every run it posts in future. */
async function adminJudge(request, env, status) {
  const auth = teacherState(request, env);
  if (auth !== "ok")
    return json(env, { error: auth === "unset" ? "no key set" : "no" }, 403);
  let body;
  try { body = await request.json(); } catch (e) { return json(env, { error: "bad json" }, 400); }
  const cls = cleanClass(body.cls);
  if (!cls) return json(env, { error: "bad class code" }, 400);
  const nick = cleanNick(body.nick);
  if (!nick) return json(env, { error: "bad nickname" }, 400);

  const now = Math.floor(Date.now() / 1000);
  /* one decision per folded name: drop any earlier spelling's row first */
  await env.DB
    .prepare("DELETE FROM names WHERE cls = ? AND " + FOLD("nick") + " = " + FOLD("?"))
    .bind(cls, nick)
    .run();
  await env.DB
    .prepare("INSERT INTO names (cls, nick, status, decided) VALUES (?, ?, ?, ?) " +
             "ON CONFLICT(cls, nick) DO UPDATE SET status = excluded.status, " +
             "decided = excluded.decided")
    .bind(cls, nick, status, now)
    .run();
  const r = await env.DB
    .prepare("UPDATE runs SET approved = ? WHERE cls = ? AND " + FOLD("nick") + " = " + FOLD("?"))
    .bind(status, cls, nick)
    .run();
  return json(env, { ok: true, nick: nick, status: status,
                     runsUpdated: (r.meta && r.meta.changes) || 0 });
}

/** Wiping a board is the one thing here that must never be a slip. With a single
 *  shared board there is no class code left to type, so the deliberateness has
 *  to come from somewhere: `all: true` must be sent explicitly. An absent or
 *  falsy field is refused, so a malformed request can never clear the board. */
/** The board AS THE TEACHER SEES IT: every row with its real name and its
 *  decision, including names already rejected.
 *
 *  A separate route rather than a flag on `/board`, deliberately. The public
 *  board not returning an unapproved name is THE safety property of the whole
 *  moderation design (SPEC 19.3), and the way that property dies is somebody
 *  adding a parameter to the same handler. This one is behind the key.
 *
 *  It exists because a rejected name was previously invisible everywhere: the
 *  pending queue only lists `approved = 0`, so a rejection made by mistake
 *  could not be found again, let alone undone. */
async function adminBoard(request, env) {
  const auth = teacherState(request, env);
  if (auth !== "ok")
    return json(env, { error: auth === "unset" ? "no key set" : "no" }, 403);
  const url = new URL(request.url);
  let limit = parseInt(url.searchParams.get("limit") || "", 10);
  if (!Number.isInteger(limit) || limit < 1) limit = 50;
  if (limit > BOARD_MAX) limit = BOARD_MAX;
  await ensureBoardColumn(env);
  const kind = url.searchParams.get("board");
  const board = kind ? cleanKind(kind) : null;
  if (kind && !board) return json(env, { error: "bad board" }, 400);
  const rows = await (board
    ? env.DB.prepare("SELECT id, cls, nick, approved, score, created, board, ver FROM runs " +
                     "WHERE board = ? ORDER BY score DESC, created ASC LIMIT ?").bind(board, limit)
    : env.DB.prepare("SELECT id, cls, nick, approved, score, created, board, ver FROM runs " +
                     "ORDER BY score DESC, created ASC LIMIT ?").bind(limit)).all();
  return json(env, { board: (rows && rows.results) || [] });
}

/** Every NAME on the board, with the year group it currently sits under.
 *
 *  This is the list the retroactive assignment tool is built on (v0.50). The
 *  board was a year old before year groups existed, so every run already posted
 *  sits under ALL; Michael knows who these pupils are by their nicknames, and
 *  this route is what lets him say so. Grouped by name rather than by run, for
 *  the same reason the moderation queue is: he is filing PEOPLE, and a pupil who
 *  has played nine times is one decision.
 *
 *  Behind the teacher key, because it returns unapproved names. */
async function adminNames(request, env) {
  const auth = teacherState(request, env);
  if (auth !== "ok")
    return json(env, { error: auth === "unset" ? "no key set" : "no" }, 403);
  let body;
  try { body = await request.json(); } catch (e) { return json(env, { error: "bad json" }, 400); }

  let only = null;
  if (body.cls !== undefined && body.cls !== null && String(body.cls).trim() !== "") {
    only = cleanClass(body.cls);
    if (!only || !isYear(only)) return json(env, { error: "bad year group" }, 400);
  }

  await ensureBoardColumn(env);
  const sql =
    "SELECT cls, MIN(nick) AS nick, COUNT(*) AS runs, MAX(score) AS best, " +
    "MAX(approved) AS approved, MIN(created) AS first, " +
    "GROUP_CONCAT(DISTINCT board) AS boards " +
    "FROM runs " + (only ? "WHERE cls = ? " : "") +
    "GROUP BY cls, " + FOLD("nick") + " ORDER BY cls ASC, best DESC LIMIT 400";
  const rows = await (only ? env.DB.prepare(sql).bind(only) : env.DB.prepare(sql)).all();
  return json(env, { names: (rows && rows.results) || [], years: YEARS });
}

/** Move a NAME, and everything it has ever posted, into a year group.
 *
 *  The unit is the name and not the run, because a pupil is one pupil: filing
 *  nine runs one at a time is how a tool stops being used, and leaving eight of
 *  them behind would put the same nickname on the board twice.
 *
 *  If the target year already holds that name, the two become one. That is not
 *  a collision to refuse: a teacher moving ALL/Dragon into Y8 where a Y8 Dragon
 *  already plays is ASSERTING they are the same pupil, which is exactly the
 *  knowledge this route exists to capture. The target's existing decision wins,
 *  so a name already approved in that year does not go back into the queue. */
async function adminAssign(request, env) {
  const auth = teacherState(request, env);
  if (auth !== "ok")
    return json(env, { error: auth === "unset" ? "no key set" : "no" }, 403);
  let body;
  try { body = await request.json(); } catch (e) { return json(env, { error: "bad json" }, 400); }

  const from = cleanClass(body.cls);
  if (!from || !isYear(from)) return json(env, { error: "bad year group" }, 400);
  const to = cleanClass(body.year);
  if (!to || YEARS.indexOf(to) < 0)
    return json(env, { error: "year must be one of " + YEARS.join(", ") }, 400);
  const nick = cleanNick(body.nick);
  if (!nick) return json(env, { error: "bad nickname" }, 400);
  if (from === to) return json(env, { ok: true, moved: 0, nick: nick, year: to, status: null });

  const now = Math.floor(Date.now() / 1000);
  await ensureBoardColumn(env);

  /* Whose decision survives: the one already made in the year being moved INTO,
     otherwise the one travelling with the name. Read before anything moves. */
  const there = await env.DB
    .prepare("SELECT status FROM names WHERE cls = ? AND " + FOLD("nick") + " = " + FOLD("?"))
    .bind(to, nick)
    .first();
  const here = await env.DB
    .prepare("SELECT status FROM names WHERE cls = ? AND " + FOLD("nick") + " = " + FOLD("?"))
    .bind(from, nick)
    .first();
  const status = there ? there.status : (here ? here.status : null);

  const r = await env.DB
    .prepare("UPDATE runs SET cls = ? WHERE cls = ? AND " + FOLD("nick") + " = " + FOLD("?"))
    .bind(to, from, nick)
    .run();

  await env.DB
    .prepare("DELETE FROM names WHERE cls = ? AND " + FOLD("nick") + " = " + FOLD("?"))
    .bind(from, nick)
    .run();
  if (status !== null) {
    await env.DB
      .prepare("DELETE FROM names WHERE cls = ? AND " + FOLD("nick") + " = " + FOLD("?"))
      .bind(to, nick)
      .run();
    await env.DB
      .prepare("INSERT INTO names (cls, nick, status, decided) VALUES (?, ?, ?, ?)")
      .bind(to, nick, status, now)
      .run();
    /* The runs carry the decision with them, so a name approved in one year does
       not arrive in another still waiting, and a rejected one does not arrive
       showing. */
    await env.DB
      .prepare("UPDATE runs SET approved = ? WHERE cls = ? AND " + FOLD("nick") + " = " + FOLD("?"))
      .bind(status, to, nick)
      .run();
  }

  return json(env, { ok: true, nick: nick, year: to,
                     moved: (r.meta && r.meta.changes) || 0, status: status });
}

/** Where the cycle is, for anybody. Public, because the splash screen shows the
 *  week and the day to every student, and because it says nothing about anyone:
 *  it is a school timetable, which is on the wall. */
async function getCycle(env) {
  const now = Math.floor(Date.now() / 1000);
  const cyc = await currentCycle(env, now);
  return json(env, cycleState(cyc, now));
}

/** Move the cycle. Michael: "sometimes we have a one-week break which offsets
 *  the cycle", so he needs to be able to say which week this one is.
 *
 *  Saying "this week is Week B" when the server thinks it is Week A does NOT
 *  renumber the year. It closes the cycle in progress at the new boundary and
 *  opens a new one, because that is what a break does to a timetable: cycle 4
 *  ended early, and cycle 5 is the one you are in. Past cycles keep the dates
 *  they actually had, so the winners of cycle 3 stay the winners of cycle 3. */
async function adminCycle(request, env) {
  const auth = teacherState(request, env);
  if (auth !== "ok")
    return json(env, { error: auth === "unset" ? "no key set" : "no" }, 403);
  let body;
  try { body = await request.json(); } catch (e) { return json(env, { error: "bad json" }, 400); }

  const now = Math.floor(Date.now() / 1000);
  let cyc = await currentCycle(env, now);
  const week = body.week;
  if (week !== "A" && week !== "B") return json(env, { error: "week must be A or B" }, 400);

  /* "This week is Week A" means the cycle starts on the Monday just gone.
     "Week B" means it started on the Monday before that. */
  const monday = localMonday(now);
  const want = week === "A" ? monday : monday - 7 * DAY;
  if (want === cyc.start)
    return json(env, { ok: true, changed: false, cycle: cycleState(cyc, now) });

  if (want > cyc.start) {
    /* The cycle in progress is cut short here and a new one begins. */
    await env.DB.prepare("UPDATE cycles SET end = ? WHERE n = ?").bind(want, cyc.n).run();
    await env.DB.prepare("INSERT INTO cycles (start, end) VALUES (?, ?)")
      .bind(want, want + CYCLE_SECONDS).run();
  } else {
    /* The cycle in progress actually began earlier than recorded, so it is
       stretched back and whatever came before it ends where this one starts. */
    await env.DB.prepare("UPDATE cycles SET start = ?, end = ? WHERE n = ?")
      .bind(want, want + CYCLE_SECONDS, cyc.n).run();
    await env.DB.prepare("UPDATE cycles SET end = ? WHERE n < ? AND end > ?")
      .bind(want, cyc.n, want).run();
  }
  cyc = await currentCycle(env, now);
  return json(env, { ok: true, changed: true, cycle: cycleState(cyc, now) });
}

/** Past cycles, and who won them. The teacher's half of the feature.
 *
 *  With no `cycle` this lists every cycle that has anything in it. With one, it
 *  returns that cycle's winners: the top name on each board in each year group,
 *  which is the list Michael reads out when he hands out the rewards. A name
 *  still waiting or rejected is returned with its real spelling, exactly as
 *  /admin/board does, because this route is behind the key. */
async function adminCycles(request, env) {
  const auth = teacherState(request, env);
  if (auth !== "ok")
    return json(env, { error: auth === "unset" ? "no key set" : "no" }, 403);
  let body;
  try { body = await request.json(); } catch (e) { return json(env, { error: "bad json" }, 400); }

  await ensureBoardColumn(env);
  const now = Math.floor(Date.now() / 1000);
  const cur = await currentCycle(env, now);

  if (body.cycle === undefined || body.cycle === null) {
    const rows = await env.DB.prepare(
      "SELECT c.n, c.start, c.end, " +
      "(SELECT COUNT(*) FROM runs r WHERE r.created >= c.start AND r.created < c.end) AS runs " +
      "FROM cycles c ORDER BY c.n DESC LIMIT 60").all();
    return json(env, { cycles: (rows && rows.results) || [], current: cur.n,
                       cycle: cycleState(cur, now) });
  }

  if (!isInt(body.cycle, 1, Number.MAX_SAFE_INTEGER))
    return json(env, { error: "bad cycle" }, 400);
  const row = await env.DB.prepare("SELECT n, start, end FROM cycles WHERE n = ?")
    .bind(body.cycle).first();
  if (!row) return json(env, { error: "no such cycle" }, 404);

  /* One winner per board per year group. Ties go to whoever got there first,
     which is the rule the board itself already sorts by. */
  const win = await env.DB.prepare(
    "SELECT board, cls, nick, score, created, approved, ver FROM (" +
    "SELECT *, ROW_NUMBER() OVER (PARTITION BY board, cls ORDER BY score DESC, created ASC) AS rn " +
    "FROM runs WHERE created >= ? AND created < ?" +
    ") WHERE rn = 1 ORDER BY board ASC, cls ASC").bind(row.start, row.end).all();

  const all = await env.DB.prepare(
    "SELECT board, cls, nick, score, created, approved, ver FROM runs " +
    "WHERE created >= ? AND created < ? ORDER BY score DESC, created ASC LIMIT ?")
    .bind(row.start, row.end, BOARD_MAX).all();

  return json(env, { cycle: row.n, start: row.start, end: row.end,
                     current: cur.n, live: row.n === cur.n,
                     winners: (win && win.results) || [],
                     board: (all && all.results) || [] });
}

async function adminClear(request, env) {
  const auth = teacherState(request, env);
  if (auth !== "ok")
    return json(env, { error: auth === "unset" ? "no key set" : "no" }, 403);
  let body;
  try { body = await request.json(); } catch (e) { return json(env, { error: "bad json" }, 400); }
  /* A wipe clears the NAME decisions in the same scope (v0.45, Michael's ruling):
     a fresh board starts with a fresh queue, rather than every name ever approved
     staying approved and open for anyone to post under. */
  let r;
  if (body.all === true) {
    r = await env.DB.prepare("DELETE FROM runs").run();
    await env.DB.prepare("DELETE FROM names").run();
  } else {
    const cls = cleanClass(body.cls);
    if (!cls) return json(env, { error: "name a year group, or send all: true" }, 400);
    r = await env.DB.prepare("DELETE FROM runs WHERE cls = ?").bind(cls).run();
    await env.DB.prepare("DELETE FROM names WHERE cls = ?").bind(cls).run();
  }
  return json(env, { ok: true, cleared: (r.meta && r.meta.changes) || 0 });
}

/* -------------------------------------------------------------------- entry */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: cors(env) });

    try {
      if (url.pathname === "/score" && request.method === "POST")
        return await postScore(request, env);
      if (url.pathname === "/board" && request.method === "GET")
        return await getBoard(url, env);
      if (url.pathname === "/cycle" && request.method === "GET")
        return await getCycle(env);
      if (url.pathname === "/admin/cycle" && request.method === "POST")
        return await adminCycle(request, env);
      if (url.pathname === "/admin/cycles" && request.method === "POST")
        return await adminCycles(request, env);
      if (url.pathname === "/admin/delete" && request.method === "POST")
        return await adminDelete(request, env);
      if (url.pathname === "/admin/pending" && request.method === "POST")
        return await adminPending(request, env);
      if (url.pathname === "/admin/board" && request.method === "POST")
        return await adminBoard(request, env);
      if (url.pathname === "/admin/names" && request.method === "POST")
        return await adminNames(request, env);
      if (url.pathname === "/admin/assign" && request.method === "POST")
        return await adminAssign(request, env);
      if (url.pathname === "/admin/approve" && request.method === "POST")
        return await adminJudge(request, env, 1);
      if (url.pathname === "/admin/reject" && request.method === "POST")
        return await adminJudge(request, env, -1);
      if (url.pathname === "/admin/clear" && request.method === "POST")
        return await adminClear(request, env);
      if (url.pathname === "/health")
        return json(env, { ok: true });

      /* A human landed on the root. The 404 that used to be here read as a
         broken deploy to the person who had just deployed it, which is a bad
         way to greet the one user who most needs reassurance. */
      if (url.pathname === "/" || url.pathname === "")
        return json(env, {
          service: "Word Class Commando leaderboard",
          ok: true,
          note: "This is the score service, not the app. The app is at " +
                "https://mamthegoat.github.io/word-class-commando/",
          routes: ["/health", "/board", "/cycle"]
        });

      return json(env, { error: "not found" }, 404);
    } catch (err) {
      /* Never leak internals to a student's browser. The app treats any failure
         as "no leaderboard today" and carries on regardless (SPEC 19.2). */
      console.log("worker error:", err && err.stack ? err.stack : String(err));
      return json(env, { error: "server error" }, 500);
    }
  }
};
