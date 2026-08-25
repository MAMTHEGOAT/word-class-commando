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
 *  3. Nicknames are composed HERE from two fixed word lists (SPEC 19.3). The
 *     client sends two integers, never text. A free-text nickname chosen by a
 *     teenager and then projected in a lesson has a known ending, and no word
 *     filter has ever won that argument. Structurally impossible beats filtered.
 *
 * Not stored, ever: real names, school identifiers, IP addresses, misconception
 * counters, anything from practice or test mode.
 */

/* Nickname parts. The client sends indexes into these; both lists are mirrored
   in the app so it can show the student their name before they submit. Keep the
   two lists append-only, or old rows stop matching what students see. */
const ADJ = [
  "Brave", "Quick", "Quiet", "Clever", "Bright", "Steady", "Bold", "Keen",
  "Swift", "Calm", "Sharp", "Lucky", "Fierce", "Nimble", "Solid", "Wily"
];
const NOUN = [
  "Otter", "Falcon", "Badger", "Heron", "Fox", "Lynx", "Raven", "Marten",
  "Osprey", "Stoat", "Kestrel", "Hare", "Owl", "Pike", "Adder", "Wren"
];

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

  if (!isInt(body.adj, 0, ADJ.length - 1) || !isInt(body.noun, 0, NOUN.length - 1))
    return json(env, { error: "bad nickname" }, 400);

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

  const nick = ADJ[body.adj] + NOUN[body.noun];

  await env.DB
    .prepare(
      "INSERT INTO runs (cls, nick, score, correct, wrong, chain, level, created) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(cls, nick, score, correct, wrong, chain, body.level, now)
    .run();

  /* Tell the student where they landed, which is the only thing they want to
     know and saves the app a second request. */
  const rank = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM runs WHERE cls = ? AND score > ?")
    .bind(cls, score)
    .first();

  return json(env, { ok: true, nick: nick, rank: (rank ? rank.n : 0) + 1 });
}

async function getBoard(url, env) {
  const cls = cleanClass(url.searchParams.get("cls"));
  if (!cls) return json(env, { error: "bad class code" }, 400);

  let limit = parseInt(url.searchParams.get("limit") || "", 10);
  if (!Number.isInteger(limit) || limit < 1) limit = BOARD_DEFAULT;
  if (limit > BOARD_MAX) limit = BOARD_MAX;

  const rows = await env.DB
    .prepare(
      "SELECT id, nick, score, correct, wrong, chain, level, created FROM runs " +
      "WHERE cls = ? ORDER BY score DESC, created ASC LIMIT ?"
    )
    .bind(cls, limit)
    .all();

  return json(env, { cls: cls, board: (rows && rows.results) || [] });
}

/** Teacher routes. One shared secret, set with `wrangler secret put TEACHER_KEY`.
 *  If the secret was never set, these refuse rather than defaulting to open. */
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
  if (!teacherOk(request, env)) return json(env, { error: "no" }, 403);
  let body;
  try { body = await request.json(); } catch (e) { return json(env, { error: "bad json" }, 400); }
  if (!isInt(body.id, 1, Number.MAX_SAFE_INTEGER)) return json(env, { error: "bad id" }, 400);
  const r = await env.DB.prepare("DELETE FROM runs WHERE id = ?").bind(body.id).run();
  return json(env, { ok: true, deleted: (r.meta && r.meta.changes) || 0 });
}

async function adminClear(request, env) {
  if (!teacherOk(request, env)) return json(env, { error: "no" }, 403);
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
