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
 *     that could not have happened, more items than sixty seconds allows, a
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
  let s = v.replace(/[\u0000-\u001F\u007F]/g, " ")   // control characters
           .replace(/[<>]/g, "")                       // never worth storing
           .replace(/\s+/g, " ")
           .trim();
  if (!s) return null;
  if ([...s].length > NICK_MAX) return null;
  return s;
}

const LEVELS = ["foundation", "developing", "secure", "challenge"];

/* Physical bounds for a sixty-second run. Deliberately generous: this is here to
   reject 999999, not to second-guess a fast student. */
const RUN_SECONDS = 60;
const MIN_MS_PER_ITEM = 350;                                  // faster than a human reads
const MAX_ITEMS = Math.floor((RUN_SECONDS * 1000) / MIN_MS_PER_ITEM);   // 171
const MAX_MULTIPLIER = 5;        // combo multiplier ceiling, mirrored in the app
const WRONG_PENALTY = 3;

/* Rate limit, measured off the runs table so that no request metadata (IP,
   headers, fingerprint) has to be stored to make it work. */
const RATE_WINDOW_SECONDS = 60;
const RATE_MAX_PER_CLASS = 40;

const BOARD_DEFAULT = 20;
const BOARD_MAX = 100;

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
  return correct * MAX_MULTIPLIER - wrong * WRONG_PENALTY;
}

/* ----------------------------------------------------------------- handlers */

async function postScore(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json(env, { error: "bad json" }, 400);
  }

  const cls = cleanClass(body.cls);
  if (!cls) return json(env, { error: "bad class code" }, 400);

  const nick = cleanNick(body.nick);
  if (!nick) return json(env, { error: "bad nickname" }, 400);

  const correct = body.correct, wrong = body.wrong, chain = body.chain, score = body.score;

  if (!isInt(correct, 0, MAX_ITEMS)) return json(env, { error: "bad correct" }, 400);
  if (!isInt(wrong, 0, MAX_ITEMS)) return json(env, { error: "bad wrong" }, 400);
  if (!isInt(chain, 0, correct)) return json(env, { error: "chain longer than correct answers" }, 400);
  if (correct + wrong > MAX_ITEMS)
    return json(env, { error: "more items than sixty seconds allows" }, 400);
  if (typeof body.level !== "string" || LEVELS.indexOf(body.level) < 0)
    return json(env, { error: "bad level" }, 400);
  if (!isInt(score, -(MAX_ITEMS * WRONG_PENALTY), MAX_ITEMS * MAX_MULTIPLIER))
    return json(env, { error: "bad score" }, 400);
  if (score > maxPossibleScore(correct, wrong))
    return json(env, { error: "score impossible for that many answers" }, 400);

  const now = Math.floor(Date.now() / 1000);

  /* Rate limit off the table itself. See the note by RATE_WINDOW_SECONDS. */
  const recent = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM runs WHERE cls = ? AND created > ?")
    .bind(cls, now - RATE_WINDOW_SECONDS)
    .first();
  if (recent && recent.n >= RATE_MAX_PER_CLASS)
    return json(env, { error: "too many scores from this class just now" }, 429);

  /* Has this name already been judged for this class? If so the decision
     carries over, so a student who has been approved once is not re-queued
     every single run. */
  const prior = await env.DB
    .prepare("SELECT status FROM names WHERE cls = ? AND nick = ?")
    .bind(cls, nick)
    .first();
  const approved = prior ? prior.status : 0;

  await env.DB
    .prepare(
      "INSERT INTO runs (cls, nick, approved, score, correct, wrong, chain, level, created) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(cls, nick, approved, score, correct, wrong, chain, body.level, now)
    .run();

  /* Tell the student where they landed, which is the only thing they want to
     know and saves the app a second request. */
  const rank = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM runs WHERE cls = ? AND score > ?")
    .bind(cls, score)
    .first();

  return json(env, { ok: true, nick: nick, approved: approved,
                     rank: (rank ? rank.n : 0) + 1 });
}

async function getBoard(url, env) {
  const cls = cleanClass(url.searchParams.get("cls"));
  if (!cls) return json(env, { error: "bad class code" }, 400);

  let limit = parseInt(url.searchParams.get("limit") || "", 10);
  if (!Number.isInteger(limit) || limit < 1) limit = BOARD_DEFAULT;
  if (limit > BOARD_MAX) limit = BOARD_MAX;

  const rows = await env.DB
    .prepare(
      "SELECT id, nick, approved, score, correct, wrong, chain, level, created FROM runs " +
      "WHERE cls = ? ORDER BY score DESC, created ASC LIMIT ?"
    )
    .bind(cls, limit)
    .all();

  /* THE safety property of the whole moderation design: an unapproved name does
     not leave this worker on the public route. Not masked on the client, not
     filtered in the app, not sent at all. The score still ranks, because holding
     the score hostage to a teacher's attention would make the board useless. */
  const board = ((rows && rows.results) || []).map(function (r) {
    const out = {
      id: r.id, score: r.score, correct: r.correct, wrong: r.wrong,
      chain: r.chain, level: r.level, created: r.created,
      status: r.approved
    };
    if (r.approved === 1) out.nick = r.nick;
    return out;
  });

  return json(env, { cls: cls, board: board });
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
  const sql =
    "SELECT cls, nick, COUNT(*) AS runs, MAX(score) AS best, MIN(created) AS first " +
    "FROM runs WHERE approved = 0 " + (cls ? "AND cls = ? " : "") +
    "GROUP BY cls, nick ORDER BY first ASC LIMIT 200";
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
  await env.DB
    .prepare("INSERT INTO names (cls, nick, status, decided) VALUES (?, ?, ?, ?) " +
             "ON CONFLICT(cls, nick) DO UPDATE SET status = excluded.status, " +
             "decided = excluded.decided")
    .bind(cls, nick, status, now)
    .run();
  const r = await env.DB
    .prepare("UPDATE runs SET approved = ? WHERE cls = ? AND nick = ?")
    .bind(status, cls, nick)
    .run();
  return json(env, { ok: true, nick: nick, status: status,
                     runsUpdated: (r.meta && r.meta.changes) || 0 });
}

async function adminClear(request, env) {
  const auth = teacherState(request, env);
  if (auth !== "ok")
    return json(env, { error: auth === "unset" ? "no key set" : "no" }, 403);
  let body;
  try { body = await request.json(); } catch (e) { return json(env, { error: "bad json" }, 400); }
  const cls = cleanClass(body.cls);
  if (!cls) return json(env, { error: "bad class code" }, 400);
  const r = await env.DB.prepare("DELETE FROM runs WHERE cls = ?").bind(cls).run();
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
      if (url.pathname === "/admin/delete" && request.method === "POST")
        return await adminDelete(request, env);
      if (url.pathname === "/admin/pending" && request.method === "POST")
        return await adminPending(request, env);
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
          routes: ["/health", "/board?cls=9B"]
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
