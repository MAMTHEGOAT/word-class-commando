/**
 * Worker tests. Drives the REAL worker module against a REAL SQLite database
 * through a small D1 shim, so the SQL is executed rather than eyeballed.
 *
 * Why a shim rather than `wrangler dev`: this container's package registry does
 * not serve wrangler, so the choice was between testing the code against real
 * SQL and not testing it at all. The shim implements only the four D1 calls the
 * worker actually makes. If the worker starts using more of the D1 API, this
 * file has to grow with it, and a missing method will throw loudly rather than
 * pass quietly.
 *
 *   node --experimental-sqlite worker/test.mjs
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const worker = (await import(join(HERE, "src/index.js"))).default;

/* ------------------------------------------------------------ the D1 shim */
function makeDB() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(join(HERE, "schema.sql"), "utf8"));
  return {
    prepare(sql) {
      const stmt = db.prepare(sql);
      let args = [];
      const api = {
        bind(...a) { args = a; return api; },
        async first() { const r = stmt.get(...args); return r === undefined ? null : r; },
        async all() { return { results: stmt.all(...args) }; },
        async run() { const r = stmt.run(...args); return { meta: { changes: Number(r.changes) } }; }
      };
      return api;
    },
    _raw: db
  };
}

const KEY = "teacher-key-for-tests";
let env;

function req(path, opts) {
  opts = opts || {};
  const init = { method: opts.method || "GET", headers: opts.headers || {} };
  if (opts.body !== undefined) {
    init.body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
    init.headers["Content-Type"] = "application/json";
  }
  return worker.fetch(new Request("https://board.example.com" + path, init), env);
}

const good = { cls: "y9", nick: "Aisha", correct: 20, wrong: 2, chain: 8, level: "secure", score: 30 };

/* ------------------------------------------------------------------ runner */
let pass = 0;
const fails = [];
function check(name, cond, detail) {
  if (cond) { pass++; }
  else { fails.push(name + (detail ? "  -> " + detail : "")); console.log("FAIL:", name, detail || ""); }
}

async function test(name, fn) {
  env = { DB: makeDB(), TEACHER_KEY: KEY, ALLOWED_ORIGIN: "https://mamthegoat.github.io" };
  await fn(name);
}

/* ------------------------------------------------------------------- tests */

await test("health and routing", async () => {
  let r = await req("/health");
  check("health returns 200", r.status === 200);
  check("CORS origin is locked to the Pages site",
    r.headers.get("Access-Control-Allow-Origin") === "https://mamthegoat.github.io",
    r.headers.get("Access-Control-Allow-Origin"));
  r = await req("/nope");
  check("unknown route is 404", r.status === 404, "got " + r.status);
  r = await req("/");
  const rootBody = await r.json();
  check("the root explains itself rather than 404ing", r.status === 200, "got " + r.status);
  check("the root points at the app", /github\.io/.test(rootBody.note || ""), rootBody.note);
  r = await req("/score", { method: "OPTIONS" });
  check("preflight returns 204", r.status === 204, "got " + r.status);
  r = await req("/score", { method: "GET" });
  check("GET /score is not allowed", r.status === 404, "got " + r.status);
});

await test("a valid score is accepted and ranked", async () => {
  let r = await req("/score", { method: "POST", body: good });
  let b = await r.json();
  check("valid score accepted", r.status === 200, r.status + " " + JSON.stringify(b));
  check("the submitted name comes back", b.nick === "Aisha", b.nick);
  check("first score ranks first", b.rank === 1, String(b.rank));

  r = await req("/score", { method: "POST", body: { ...good, nick: "Ben", score: 50 } });
  b = await r.json();
  check("higher score ranks first", b.rank === 1, String(b.rank));
  r = await req("/score", { method: "POST", body: { ...good, nick: "Cal", score: 10 } });
  b = await r.json();
  check("lower score ranks third", b.rank === 3, String(b.rank));

  r = await req("/board?cls=Y9");
  b = await r.json();
  check("board returns all three", b.board.length === 3, String(b.board.length));
  check("board is ordered high to low",
    b.board[0].score === 50 && b.board[1].score === 30 && b.board[2].score === 10,
    JSON.stringify(b.board.map(x => x.score)));
  /* Guards against a field being added to the board response by accident. The
     unapproved shape matters most: `nick` must be ABSENT, not null or masked. */
  check("an unapproved row carries no nick field at all",
    Object.keys(b.board[0]).sort().join(",") ===
    "chain,cls,correct,created,id,level,score,status,wrong",
    Object.keys(b.board[0]).sort().join(","));
  await req("/admin/approve", { method: "POST", body: { cls: "Y9", nick: "Ben" },
                                headers: { "X-Teacher-Key": KEY } });
  r = await req("/board?cls=Y9");
  b = await r.json();
  const approvedRow = b.board.filter(x => x.nick === "Ben")[0];
  check("an approved row adds nick and nothing else",
    approvedRow && Object.keys(approvedRow).sort().join(",") ===
    "chain,cls,correct,created,id,level,nick,score,status,wrong",
    approvedRow && Object.keys(approvedRow).sort().join(","));
});

await test("free-text nicknames are accepted but never shown unapproved", async () => {
  /* SPEC 19.3 as revised: the student types their own name, and the SAFETY
     property is that the public board never returns it until a person approves.
     This is the single most important test in this file. */
  let r = await req("/score", { method: "POST", body: { ...good, nick: "Something Rude" } });
  let b = await r.json();
  check("a free-text name is accepted", r.status === 200, r.status + " " + JSON.stringify(b));
  check("and comes back to its own author", b.nick === "Something Rude", b.nick);
  check("and starts unapproved", b.approved === 0, String(b.approved));
  check("but the score still ranks immediately", b.rank === 1, String(b.rank));

  r = await req("/board?cls=Y9");
  b = await r.json();
  const raw = JSON.stringify(b);
  check("the public board does NOT contain the unapproved name",
    raw.indexOf("Something Rude") < 0, raw.slice(0, 200));
  check("the row is still on the board, without a name",
    b.board.length === 1 && b.board[0].nick === undefined && b.board[0].status === 0,
    JSON.stringify(b.board[0]));

  for (const bad of [{ nick: "" }, { nick: "   " }, { nick: 42 },
                     { nick: "x".repeat(17) }, { nick: "\u0000\u0001" }]) {
    const rr = await req("/score", { method: "POST", body: { ...good, ...bad } });
    check("rejected as a name: " + JSON.stringify(bad), rr.status === 400, "got " + rr.status);
  }
  r = await req("/score", { method: "POST", body: { ...good, nick: "  Ada   Lovelace  " } });
  b = await r.json();
  check("whitespace is tidied rather than refused", b.nick === "Ada Lovelace", b.nick);
  r = await req("/score", { method: "POST", body: { ...good, nick: "<b>bold</b>" } });
  b = await r.json();
  check("angle brackets are stripped before storage", b.nick === "bbold/b", b.nick);
});

await test("moderation: approve, reject, and judge a name only once", async () => {
  await req("/score", { method: "POST", body: { ...good, nick: "Aisha", score: 40 } });
  await req("/score", { method: "POST", body: { ...good, nick: "Aisha", score: 20 } });
  await req("/score", { method: "POST", body: { ...good, nick: "Rude One", score: 30 } });

  let r = await req("/admin/pending", { method: "POST", body: { cls: "Y9" } });
  check("pending needs the teacher key", r.status === 403, "got " + r.status);
  r = await req("/admin/pending", { method: "POST", body: { cls: "Y9" },
                                    headers: { "X-Teacher-Key": KEY } });
  let b = await r.json();
  check("pending lists NAMES not runs", b.pending.length === 2, JSON.stringify(b.pending));
  const aisha = b.pending.filter(p => p.nick === "Aisha")[0];
  check("and groups a repeat player into one decision", aisha && aisha.runs === 2,
    JSON.stringify(aisha));
  check("every pending row carries its own year group", b.pending.every(p => p.cls === "Y9"),
    JSON.stringify(b.pending));

  /* The class is a FILTER, not a credential. A teacher does not necessarily
     know which class a name was posted under, and the key is what authorises
     this route, so asking them to name the class is asking for something the
     server already knows. */
  await req("/score", { method: "POST", body: { ...good, cls: "Y7", nick: "Farid", score: 11 } });
  r = await req("/admin/pending", { method: "POST", body: {},
                                    headers: { "X-Teacher-Key": KEY } });
  b = await r.json();
  check("with no year group given, pending spans every year",
    b.pending.length === 3 && b.pending.some(p => p.cls === "Y7"), JSON.stringify(b.pending));
  check("and it still needs the key",
    (await req("/admin/pending", { method: "POST", body: {} })).status === 403);
  r = await req("/admin/pending", { method: "POST", body: { cls: "" },
                                    headers: { "X-Teacher-Key": KEY } });
  check("an empty year string means all years, not a bad request", r.status === 200,
    "got " + r.status);
  r = await req("/admin/pending", { method: "POST", body: { cls: "not a year!!" },
                                    headers: { "X-Teacher-Key": KEY } });
  check("but a year group that is junk is still refused", r.status === 400, "got " + r.status);

  /* A worker with no secret set must say so rather than blaming the password.
     Michael hit this: the page said "that password was not accepted" when the
     real state was that the worker had no password to accept. */
  const noKeyEnv = { ...env, TEACHER_KEY: undefined };
  r = await worker.fetch(new Request("https://x/admin/pending",
        { method: "POST", body: "{}", headers: { "X-Teacher-Key": KEY } }), noKeyEnv);
  check("a worker with no secret set says so, rather than blaming the key",
    r.status === 403 && (await r.json()).error === "no key set", "got " + r.status);
  r = await req("/admin/pending", { method: "POST", body: {},
                                    headers: { "X-Teacher-Key": "definitely-wrong" } });
  check("and a genuinely wrong key still says only 'no'",
    r.status === 403 && (await r.json()).error === "no", "got " + r.status);

  /* Clearing a board is deliberately NOT like this: you have to name it. */
  r = await req("/admin/clear", { method: "POST", body: {},
                                  headers: { "X-Teacher-Key": KEY } });
  check("clearing a board still demands an explicit class", r.status === 400, "got " + r.status);

  await req("/admin/reject", { method: "POST", body: { cls: "Y7", nick: "Farid" },
                               headers: { "X-Teacher-Key": KEY } });

  r = await req("/admin/approve", { method: "POST", body: { cls: "Y9", nick: "Aisha" },
                                    headers: { "X-Teacher-Key": KEY } });
  b = await r.json();
  check("approving updates every run that name posted", b.runsUpdated === 2, JSON.stringify(b));

  r = await req("/board?cls=Y9");
  b = await r.json();
  const named = b.board.filter(x => x.nick === "Aisha");
  /* one line per name since v0.45: Aisha's two runs show as her best one */
  check("the approved name now appears, once, at its best",
    named.length === 1 && named[0].score === Math.max(...b.board.map(x => x.score)), JSON.stringify(b.board));
  check("the unjudged name still does not",
    JSON.stringify(b.board).indexOf("Rude One") < 0, JSON.stringify(b.board));

  /* the decision must carry to FUTURE runs, or the queue is unusable */
  r = await req("/score", { method: "POST", body: { ...good, nick: "Aisha", score: 60 } });
  b = await r.json();
  check("a later run by an approved name is approved on arrival", b.approved === 1,
    String(b.approved));

  r = await req("/admin/reject", { method: "POST", body: { cls: "Y9", nick: "Rude One" },
                                   headers: { "X-Teacher-Key": KEY } });
  b = await r.json();
  check("rejecting works", b.status === -1, JSON.stringify(b));
  r = await req("/score", { method: "POST", body: { ...good, nick: "Rude One", score: 55 } });
  b = await r.json();
  check("a rejected name stays rejected on its next run", b.approved === -1, String(b.approved));
  r = await req("/board?cls=Y9");
  b = await r.json();
  check("and never reaches the board",
    JSON.stringify(b.board).indexOf("Rude One") < 0, JSON.stringify(b.board));
  check("even though its score is ranked",
    b.board.filter(x => x.score === 55).length === 1, JSON.stringify(b.board));
});

await test("the impossible is rejected", async () => {
  const cases = [
    ["a wildly inflated score", { score: 999999 }],
    ["a score above what those answers allow", { correct: 10, wrong: 0, chain: 5, score: 51 }],
    ["a chain longer than the correct answers", { correct: 5, chain: 6 }],
    ["more items than sixty seconds allows", { correct: 200, wrong: 0, chain: 1 }],
    ["negative correct", { correct: -1 }],
    ["a level that does not exist", { level: "impossible" }],
    ["a non-integer score", { score: 12.5 }],
    ["a year group with markup in it", { cls: "<script>" }],
    ["a year group that is not one of the five", { cls: "Y13" }]
  ];
  for (const [name, patch] of cases) {
    const r = await req("/score", { method: "POST", body: { ...good, ...patch } });
    check("rejected: " + name, r.status === 400, "got " + r.status);
  }
  const r = await req("/score", { method: "POST", body: "not json at all" });
  check("rejected: malformed json", r.status === 400, "got " + r.status);

  /* The bound is deliberately loose: a legitimately excellent run must pass. */
  const okRun = await req("/score", {
    method: "POST", body: { ...good, correct: 40, wrong: 1, chain: 30, score: 150 }
  });
  check("a genuinely excellent run is still accepted", okRun.status === 200, "got " + okRun.status);
});

await test("a run has to be worth something to go on the board", async () => {
  /* Students raced each other for the WORST score, which is a second
     leaderboard running the other way. The refusal lives in the worker because
     the board is public and a client-side rule is only a suggestion. */
  for (const bad of [-1, -5, -30]) {
    const r = await req("/score", { method: "POST",
      body: { ...good, correct: 0, wrong: 10, chain: 0, score: bad } });
    check("a score of " + bad + " is refused", r.status === 400, "got " + r.status);
  }
  let r = await req("/score", { method: "POST",
    body: { ...good, correct: 3, wrong: 3, chain: 1, score: 0 } });
  check("zero is accepted: the bar is zero or better, not high",
    r.status === 200, "got " + r.status);
  r = await req("/board");
  const b = await r.json();
  check("so nothing on the board is negative",
    b.board.every(x => x.score >= 0), JSON.stringify(b.board.map(x => x.score)));
});

await test("the teacher can see and undo a rejection", async () => {
  /* A rejected name used to be invisible everywhere: the pending queue lists
     only approved = 0, and the public board strips the name from anything that
     is not approved = 1, so a rejection made by mistake could not be found
     again. Worse, the app rendered rejected and pending identically, so three
     rejected rows read as "waiting for approval" with an empty queue. */
  await req("/score", { method: "POST", body: { ...good, nick: "Rude One", score: 40 } });
  await req("/score", { method: "POST", body: { ...good, nick: "Fine One", score: 20 } });
  await req("/admin/reject", { method: "POST", body: { cls: "Y9", nick: "Rude One" },
                               headers: { "X-Teacher-Key": KEY } });

  let r = await req("/admin/pending", { method: "POST", body: {},
                                        headers: { "X-Teacher-Key": KEY } });
  let b = await r.json();
  check("a rejected name is NOT in the pending queue",
    !b.pending.some(p => p.nick === "Rude One"), JSON.stringify(b.pending));

  r = await req("/board");
  b = await r.json();
  check("and the public board still refuses to send its name",
    JSON.stringify(b).indexOf("Rude One") < 0, JSON.stringify(b).slice(0, 200));
  check("but it does say the row was DECIDED, not that it is waiting",
    b.board.some(x => x.status === -1), JSON.stringify(b.board.map(x => x.status)));

  r = await req("/admin/board", { method: "POST", body: {} });
  check("the teacher board needs the key", r.status === 403, "got " + r.status);
  r = await req("/admin/board", { method: "POST", body: {},
                                  headers: { "X-Teacher-Key": KEY } });
  b = await r.json();
  const rude = b.board.filter(x => x.nick === "Rude One")[0];
  check("the teacher board shows the rejected name so it can be found again",
    rude && rude.approved === -1, JSON.stringify(b.board));
  check("and it shows the undecided and approved ones too",
    b.board.length === 2, b.board.length);

  /* and the decision can be reversed */
  await req("/admin/approve", { method: "POST", body: { cls: "Y9", nick: "Rude One" },
                                headers: { "X-Teacher-Key": KEY } });
  r = await req("/board");
  b = await r.json();
  check("approving a previously rejected name puts it back on the board",
    b.board.some(x => x.nick === "Rude One"), JSON.stringify(b.board));
});

await test("the one shared board", async () => {
  /* Students are not asked for a class code any more (2026-08-25). */
  let r = await req("/score", { method: "POST", body: { ...good, cls: undefined } });
  check("a score with no year group is accepted", r.status === 200, "got " + r.status);
  r = await req("/score", { method: "POST", body: { ...good, cls: "" } });
  check("and an empty one means the same thing", r.status === 200, "got " + r.status);

  r = await req("/board");
  let b = await r.json();
  check("the board with no class is the shared one (one line per name)", r.status === 200 && b.board.length >= 1,
    JSON.stringify(b).slice(0, 160));

  /* A code still filters, so nothing posted under one before the change is
     stranded, and per-class boards stay possible without a migration. */
  await req("/score", { method: "POST", body: { ...good, cls: "Y7", nick: "Farid" } });
  r = await req("/board?cls=Y7");
  b = await r.json();
  check("a year group still filters when one is given",
    b.board.length === 1, JSON.stringify(b.board));
  r = await req("/board");
  b = await r.json();
  check("and the shared board contains it too", b.board.length >= 2, b.board.length);

  /* Clearing is the one thing that must never be a slip. */
  r = await req("/admin/clear", { method: "POST", body: {},
                                  headers: { "X-Teacher-Key": KEY } });
  check("clearing with nothing named is refused", r.status === 400, "got " + r.status);
  r = await req("/admin/clear", { method: "POST", body: { all: "yes" },
                                  headers: { "X-Teacher-Key": KEY } });
  check("and a merely truthy all is not enough", r.status === 400, "got " + r.status);
  r = await req("/admin/clear", { method: "POST", body: { all: true },
                                  headers: { "X-Teacher-Key": KEY } });
  check("all: true wipes every board", r.status === 200, "got " + r.status);
  r = await req("/board");
  b = await r.json();
  check("and the board is then empty", b.board.length === 0, JSON.stringify(b.board));
});

await test("rate limiting", async () => {
  let last;
  /* The ceiling is the whole app now rather than one class, because there is
     one board. It has to sit above several classes playing at once. */
  for (let i = 0; i < 30; i++) last = await req("/score", { method: "POST", body: good });
  check("a class of thirty playing at once is NOT throttled", last.status === 200,
    "got " + last.status);
  for (let i = 0; i < 220; i++) last = await req("/score", { method: "POST", body: good });
  check("a flood is eventually refused", last.status === 429, "got " + last.status);
  /* This USED to assert that another class was unaffected. With one shared board
     every run lands under the same code, so there is no isolation left to have:
     the ceiling is the whole app and a flood stops everyone. That is the honest
     trade of a single board, and it is survivable because a refused submit is
     queued on the device and retried rather than lost (invariant 4). */
  const other = await req("/score", { method: "POST", body: { ...good, cls: "KS4" } });
  check("the ceiling is app-wide now, so naming a year group does not dodge it",
    other.status === 429, "got " + other.status);
});

await test("teacher routes", async () => {
  await req("/score", { method: "POST", body: good });
  await req("/score", { method: "POST", body: { ...good, nick: "Dee" } });

  let r = await req("/admin/delete", { method: "POST", body: { id: 1 } });
  check("delete without a key is refused", r.status === 403, "got " + r.status);
  r = await req("/admin/delete", { method: "POST", body: { id: 1 }, headers: { "X-Teacher-Key": "wrong" } });
  check("delete with a wrong key is refused", r.status === 403, "got " + r.status);
  r = await req("/admin/delete", { method: "POST", body: { id: 1 }, headers: { "X-Teacher-Key": KEY } });
  let b = await r.json();
  check("delete with the right key works", r.status === 200 && b.deleted === 1, JSON.stringify(b));

  r = await req("/admin/clear", { method: "POST", body: { cls: "Y9" }, headers: { "X-Teacher-Key": KEY } });
  b = await r.json();
  check("clear removes the rest of the class", b.cleared === 1, JSON.stringify(b));
  r = await req("/board?cls=Y9");
  b = await r.json();
  check("board is empty after a clear", b.board.length === 0, String(b.board.length));
});

await test("an unset teacher key fails closed", async () => {
  env = { DB: makeDB(), ALLOWED_ORIGIN: "x" };            // no TEACHER_KEY at all
  const r = await req("/admin/clear", { method: "POST", body: { cls: "Y9" }, headers: { "X-Teacher-Key": "" } });
  check("with no secret set, admin refuses rather than opening", r.status === 403, "got " + r.status);
});

await test("board query hygiene", async () => {
  await req("/score", { method: "POST", body: good });
  let r = await req("/board?cls=Y9&limit=99999");
  let b = await r.json();
  check("an absurd limit is capped, not obeyed", r.status === 200 && b.board.length <= 100);
  r = await req("/board?cls=%3Cscript%3E");
  check("a class code with markup in it is still refused", r.status === 400, "got " + r.status);
  r = await req("/board?cls=" + encodeURIComponent("' OR 1=1 --"));
  check("an injection attempt is refused by the class-code rule", r.status === 400, "got " + r.status);
});

/* ---------------------------------------------------- boards (SPEC 50) */
await test("one board per challenge, one approval for all of them", async () => {
  const run = (board, nick, score) => req("/score", { method: "POST",
    body: Object.assign({}, good, { cls: undefined, nick: nick, board: board, score: score }) });
  let r = await run("punc", "Mai", 20);
  check("a punctuation run is accepted", r.status === 200, "got " + r.status);
  r = await run(undefined, "Mai", 25);
  check("a run with no board is a word classes run", (await r.json()).board === "wc");
  await run("tense", "Ben", 22);
  let b = await (await req("/board?board=punc")).json();
  check("the punctuation board holds only punctuation runs", b.board.length === 1, JSON.stringify(b.board));
  b = await (await req("/board")).json();
  check("the default board is word classes, which is what old apps ask for", b.board.length === 1 && b.board[0].score === 25,
        JSON.stringify(b.board));
  r = await req("/board?board=nonsense");
  check("an unknown board is refused", r.status === 400, "got " + r.status);
  r = await run("nonsense", "Mai", 5);
  check("and cannot be posted to", r.status === 400, "got " + r.status);

  const H = { "X-Teacher-Key": KEY };
  b = await (await req("/admin/pending", { method: "POST", headers: H, body: {} })).json();
  const mai = b.pending.filter(p => p.nick === "Mai")[0];
  check("the queue is ONE queue: Mai is one decision across two boards", mai && mai.runs === 2, JSON.stringify(b.pending));
  check("and the teacher can see which boards the name has played", mai && /punc/.test(mai.boards) && /wc/.test(mai.boards),
        mai && mai.boards);
  await req("/admin/approve", { method: "POST", headers: H, body: { cls: "ALL", nick: "Mai" } });
  const p1 = await (await req("/board?board=punc")).json(), p2 = await (await req("/board?board=wc")).json();
  check("approving once names her on every board", p1.board[0].nick === "Mai" && p2.board[0].nick === "Mai",
        JSON.stringify([p1.board, p2.board]));
  r = await run("ult", "Mai", 10);
  check("and her future runs on a new board go straight up", (await r.json()).approved === 1);
});

await test("each board has its own physical bounds", async () => {
  const post = (board, correct) => req("/score", { method: "POST",
    body: { nick: "Pim", board: board, correct: correct, wrong: 0, chain: 1, level: "secure", score: correct } });
  let r = await post("wc", 200);
  check("two hundred answers is impossible in sixty seconds", r.status === 400, "got " + r.status);
  r = await post("ult", 200);
  check("but possible in the two-minute Ultimate run", r.status === 200, "got " + r.status);
});

await test("audit 2026-09-22: the -5 floor, name variants, rank, one line per name, clear", async () => {
  const H = { "X-Teacher-Key": KEY };
  /* twelve wrong at the floor, then ten right: the app scores 17 */
  let r = await req("/score", { method: "POST",
    body: { nick: "Floor", correct: 10, wrong: 12, chain: 10, level: "secure", score: 17 } });
  check("an honest run that recovered from the -5 floor is accepted", r.status === 200, "got " + r.status);
  r = await req("/score", { method: "POST",
    body: { nick: "Floor", correct: 10, wrong: 12, chain: 10, level: "secure", score: 46 } });
  check("but the bound still refuses the impossible", r.status === 400, "got " + r.status);

  /* one decision covers every spelling */
  await req("/score", { method: "POST", body: { ...good, cls: undefined, nick: "Rude" } });
  await req("/admin/reject", { method: "POST", body: { cls: "ALL", nick: "Rude" }, headers: H });
  for (const v of ["RUDE", "R u d e", "rude"]) {
    r = await req("/score", { method: "POST", body: { ...good, cls: undefined, nick: v } });
    const b = await r.json();
    check("rejecting Rude also rejects " + JSON.stringify(v), b.approved === -1, JSON.stringify(b));
  }
  r = await req("/admin/pending", { method: "POST", body: {}, headers: H });
  let b = await r.json();
  check("and none of the variants refill the queue",
    !b.pending.some(p => p.nick.replace(/ /g, "").toLowerCase() === "rude"), JSON.stringify(b.pending));

  /* invisible characters */
  r = await req("/score", { method: "POST", body: { ...good, cls: undefined, nick: "\u200B\u200B" } });
  check("a name of only zero-width characters is refused", r.status === 400, "got " + r.status);
  r = await req("/score", { method: "POST", body: { ...good, cls: undefined, nick: "\u202EhsiA" } });
  b = await r.json();
  check("a direction override is stripped from a name", r.status === 200 && b.nick === "hsiA", JSON.stringify(b));

  /* one line per name, and rank counted the same way */
  await req("/score", { method: "POST", body: { ...good, cls: undefined, nick: "Keen", score: 50, correct: 25 } });
  await req("/score", { method: "POST", body: { ...good, cls: undefined, nick: "Keen", score: 45, correct: 25 } });
  await req("/score", { method: "POST", body: { ...good, cls: undefined, nick: "keen", score: 44, correct: 25 } });
  r = await req("/board");
  b = await r.json();
  const scores = b.board.map(x => x.score);
  check("one pupil's several runs are one line on the board, at their best",
    scores.filter(x => x === 50).length === 1 && scores.indexOf(45) < 0 && scores.indexOf(44) < 0, JSON.stringify(scores));
  r = await req("/score", { method: "POST", body: { ...good, cls: undefined, nick: "Next", score: 40, correct: 25 } });
  b = await r.json();
  const board = (await (await req("/board")).json()).board;
  const pos = board.findIndex(x => x.score === 40) + 1;
  check("rank in the reply matches the line on the public board", b.rank === pos, b.rank + " vs " + pos);
  r = await req("/score", { method: "POST", body: { ...good, cls: undefined, nick: "Keen", score: 10, correct: 25 } });
  b = await r.json();
  check("and a run below the pupil's best says so", b.isBest === false && b.best === 50, JSON.stringify(b));

  /* a clear also clears the name decisions */
  await req("/admin/clear", { method: "POST", body: { all: true }, headers: H });
  r = await req("/score", { method: "POST", body: { ...good, cls: undefined, nick: "Rude" } });
  b = await r.json();
  check("after a full clear, an old decision no longer applies", b.approved === 0, JSON.stringify(b));
});

await test("year groups (v0.50)", async () => {
  const H = { "X-Teacher-Key": KEY };
  await req("/admin/clear", { method: "POST", body: { all: true }, headers: H });

  /* The list is closed. The app is the only client, so an open field would let a
     typo quietly create a sixth year group that nobody can see is wrong. */
  for (const bad of ["Y13", "9B", "YEAR8", "ALLX"]) {
    const r = await req("/score", { method: "POST", body: { ...good, cls: bad } });
    check("refused as a year group: " + bad, r.status === 400, bad + " got " + r.status);
  }
  for (const okYear of ["Y7", "Y8", "Y9", "KS4", "OTHER", "ALL"]) {
    const r = await req("/score", { method: "POST", body: { ...good, cls: okYear, nick: "N" + okYear } });
    check("accepted: " + okYear, r.status === 200, okYear + " got " + r.status);
  }
  let r = await req("/score", { method: "POST", body: { ...good, cls: "ks4", nick: "Lower" } });
  check("a lower-case year group is the same year group", r.status === 200, "got " + r.status);

  /* Michael's ruling: a Year 7 Dragon and a Year 9 Dragon are two pupils. */
  await req("/admin/clear", { method: "POST", body: { all: true }, headers: H });
  await req("/score", { method: "POST", body: { ...good, cls: "Y7", nick: "Dragon", score: 20 } });
  await req("/score", { method: "POST", body: { ...good, cls: "Y9", nick: "Dragon", score: 40 } });
  r = await req("/board");
  let b = await r.json();
  check("the same name in two years is two lines on the all-years board",
    b.board.length === 2, JSON.stringify(b.board.map(x => x.cls + ":" + x.score)));
  check("and each line carries the year it came from",
    b.board.map(x => x.cls).sort().join(",") === "Y7,Y9", JSON.stringify(b.board));
  r = await req("/admin/pending", { method: "POST", body: {}, headers: H });
  b = await r.json();
  check("and each is its own decision for the teacher", b.pending.length === 2,
    JSON.stringify(b.pending));
  await req("/admin/approve", { method: "POST", body: { cls: "Y7", nick: "Dragon" }, headers: H });
  r = await req("/board?cls=Y9");
  b = await r.json();
  check("approving one does not show the other",
    b.board.length === 1 && b.board[0].nick === undefined, JSON.stringify(b.board));

  /* Two ranks, because the app opens on the all-years board and a pupil plays in
     one year. Before v0.50 sending a class code made the ONLY rank a within-class
     one, which would have quietly changed what every pupil was told. */
  r = await req("/score", { method: "POST", body: { ...good, cls: "Y7", nick: "Kit", score: 30 } });
  b = await r.json();
  check("the rank is across every year", b.rank === 2, JSON.stringify(b));
  check("and the year rank is beside it", b.yearRank === 1, JSON.stringify(b));
  check("the run says which year it landed in", b.cls === "Y7", JSON.stringify(b));

  /* Which filters have anything behind them, so the app offers the years that
     exist rather than five chips leading to four empty boards. */
  r = await req("/board");
  b = await r.json();
  check("the board says which years are on it",
    (b.years || []).sort().join(",") === "Y7,Y9", JSON.stringify(b.years));
  r = await req("/board?cls=Y13");
  check("and a year group that is not one of the five is refused here too",
    r.status === 400, "got " + r.status);
});

await test("filing an old board by year group (v0.50)", async () => {
  const H = { "X-Teacher-Key": KEY };
  await req("/admin/clear", { method: "POST", body: { all: true }, headers: H });
  /* The board existed for a year before year groups did, so this is what every
     run already on it looks like. */
  await req("/score", { method: "POST", body: { ...good, cls: undefined, nick: "Dragon", score: 20 } });
  await req("/score", { method: "POST", body: { ...good, cls: undefined, nick: "dragon", score: 44 } });
  await req("/score", { method: "POST", body: { ...good, cls: undefined, nick: "Aisha", score: 12 } });

  let r = await req("/admin/names", { method: "POST", body: {} });
  check("the name list needs the teacher key", r.status === 403, "got " + r.status);
  r = await req("/admin/names", { method: "POST", body: {}, headers: H });
  let b = await r.json();
  check("it lists names, not runs", b.names.length === 2, JSON.stringify(b.names));
  const dragon = b.names.filter(n => n.nick.toLowerCase() === "dragon")[0];
  check("two spellings of one name are one row", dragon && dragon.runs === 2,
    JSON.stringify(dragon));
  check("and it says where that name currently counts", dragon.cls === "ALL", dragon.cls);

  r = await req("/admin/assign", { method: "POST", body: { cls: "ALL", nick: "Dragon", year: "Y9" } });
  check("assigning needs the teacher key", r.status === 403, "got " + r.status);
  r = await req("/admin/assign", { method: "POST",
    body: { cls: "ALL", nick: "Dragon", year: "Y13" }, headers: H });
  check("and the target has to be a real year group", r.status === 400, "got " + r.status);

  r = await req("/admin/assign", { method: "POST",
    body: { cls: "ALL", nick: "Dragon", year: "Y9" }, headers: H });
  b = await r.json();
  check("every run that name has posted moves at once", b.moved === 2, JSON.stringify(b));
  r = await req("/board?cls=Y9");
  b = await r.json();
  check("and they are all in the new year", b.board.length === 1 && b.board[0].score === 44,
    JSON.stringify(b.board));
  r = await req("/board?cls=ALL");
  b = await r.json();
  check("with nothing left behind in Not stated",
    b.board.length === 1, JSON.stringify(b.board));

  /* The decision travels, or an approved name arrives in its new year still
     waiting and the teacher approves the same pupil twice. */
  await req("/admin/approve", { method: "POST", body: { cls: "ALL", nick: "Aisha" }, headers: H });
  r = await req("/admin/assign", { method: "POST",
    body: { cls: "ALL", nick: "Aisha", year: "Y8" }, headers: H });
  b = await r.json();
  check("an approved name stays approved when it moves", b.status === 1, JSON.stringify(b));
  r = await req("/board?cls=Y8");
  b = await r.json();
  check("and its name still shows", b.board[0] && b.board[0].nick === "Aisha",
    JSON.stringify(b.board));

  /* Moving a name into a year that already has it is the teacher ASSERTING they
     are the same pupil, which is the knowledge the route exists to capture. The
     decision already made in that year wins. */
  await req("/score", { method: "POST", body: { ...good, cls: "Y7", nick: "Twin", score: 15 } });
  await req("/score", { method: "POST", body: { ...good, cls: undefined, nick: "twin", score: 25 } });
  await req("/admin/reject", { method: "POST", body: { cls: "Y7", nick: "Twin" }, headers: H });
  r = await req("/admin/assign", { method: "POST",
    body: { cls: "ALL", nick: "Twin", year: "Y7" }, headers: H });
  b = await r.json();
  check("merging keeps the decision already made in the year moved into",
    b.status === -1, JSON.stringify(b));
  r = await req("/board?cls=Y7");
  b = await r.json();
  const twin = b.board.filter(x => x.score === 25)[0];
  check("and the arriving runs take that decision with them",
    twin && twin.status === -1 && twin.nick === undefined, JSON.stringify(b.board));
  check("one pupil, one line", b.board.filter(x => x.status === -1).length === 1,
    JSON.stringify(b.board));

  r = await req("/admin/assign", { method: "POST",
    body: { cls: "Y7", nick: "Twin", year: "Y7" }, headers: H });
  b = await r.json();
  check("moving a name to the year it is already in does nothing and says so",
    r.status === 200 && b.moved === 0, JSON.stringify(b));
});

await test("an old database gets its board column on the first request", async () => {
  const db = env.DB._raw;
  db.exec("DROP TABLE runs");
  db.exec("CREATE TABLE runs (id INTEGER PRIMARY KEY AUTOINCREMENT, cls TEXT NOT NULL, nick TEXT NOT NULL, " +
          "approved INTEGER NOT NULL DEFAULT 0, score INTEGER NOT NULL, correct INTEGER NOT NULL, " +
          "wrong INTEGER NOT NULL, chain INTEGER NOT NULL, level TEXT NOT NULL, created INTEGER NOT NULL)");
  db.exec("INSERT INTO runs (cls, nick, approved, score, correct, wrong, chain, level, created) " +
          "VALUES ('ALL', 'Old', 1, 40, 20, 0, 20, 'secure', 1)");
  const mod = await import(join(HERE, "src/index.js") + "?fresh=" + Date.now());
  const r = await mod.default.fetch(new Request("https://board.example.com/board"), env);
  const b = await r.json();
  check("the old row is still there, on the word classes board", r.status === 200 && b.board.length === 1 && b.board[0].score === 40,
        r.status + " " + JSON.stringify(b));
  const again = await mod.default.fetch(new Request("https://board.example.com/board?board=punc"), env);
  check("and asking twice does not trip over the column it added", again.status === 200, "got " + again.status);
});

console.log("\npassed: " + pass + "   failed: " + fails.length);
for (const f of fails) console.log("  - " + f);
process.exit(fails.length ? 1 : 0);
