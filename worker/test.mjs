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

const good = { cls: "9b", nick: "Aisha", correct: 20, wrong: 2, chain: 8, level: "secure", score: 30 };

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

  r = await req("/board?cls=9B");
  b = await r.json();
  check("board returns all three", b.board.length === 3, String(b.board.length));
  check("board is ordered high to low",
    b.board[0].score === 50 && b.board[1].score === 30 && b.board[2].score === 10,
    JSON.stringify(b.board.map(x => x.score)));
  /* Guards against a field being added to the board response by accident. The
     unapproved shape matters most: `nick` must be ABSENT, not null or masked. */
  check("an unapproved row carries no nick field at all",
    Object.keys(b.board[0]).sort().join(",") ===
    "chain,correct,created,id,level,score,status,wrong",
    Object.keys(b.board[0]).sort().join(","));
  await req("/admin/approve", { method: "POST", body: { cls: "9B", nick: "Ben" },
                                headers: { "X-Teacher-Key": KEY } });
  r = await req("/board?cls=9B");
  b = await r.json();
  const approvedRow = b.board.filter(x => x.nick === "Ben")[0];
  check("an approved row adds nick and nothing else",
    approvedRow && Object.keys(approvedRow).sort().join(",") ===
    "chain,correct,created,id,level,nick,score,status,wrong",
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

  r = await req("/board?cls=9B");
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

  let r = await req("/admin/pending", { method: "POST", body: { cls: "9B" } });
  check("pending needs the teacher key", r.status === 403, "got " + r.status);
  r = await req("/admin/pending", { method: "POST", body: { cls: "9B" },
                                    headers: { "X-Teacher-Key": KEY } });
  let b = await r.json();
  check("pending lists NAMES not runs", b.pending.length === 2, JSON.stringify(b.pending));
  const aisha = b.pending.filter(p => p.nick === "Aisha")[0];
  check("and groups a repeat player into one decision", aisha && aisha.runs === 2,
    JSON.stringify(aisha));
  check("every pending row carries its own class", b.pending.every(p => p.cls === "9B"),
    JSON.stringify(b.pending));

  /* The class is a FILTER, not a credential. A teacher does not necessarily
     know which class a name was posted under, and the key is what authorises
     this route, so asking them to name the class is asking for something the
     server already knows. */
  await req("/score", { method: "POST", body: { ...good, cls: "7C", nick: "Farid", score: 11 } });
  r = await req("/admin/pending", { method: "POST", body: {},
                                    headers: { "X-Teacher-Key": KEY } });
  b = await r.json();
  check("with no class given, pending spans every class",
    b.pending.length === 3 && b.pending.some(p => p.cls === "7C"), JSON.stringify(b.pending));
  check("and it still needs the key",
    (await req("/admin/pending", { method: "POST", body: {} })).status === 403);
  r = await req("/admin/pending", { method: "POST", body: { cls: "" },
                                    headers: { "X-Teacher-Key": KEY } });
  check("an empty class string means all classes, not a bad request", r.status === 200,
    "got " + r.status);
  r = await req("/admin/pending", { method: "POST", body: { cls: "not a class!!" },
                                    headers: { "X-Teacher-Key": KEY } });
  check("but a class code that is junk is still refused", r.status === 400, "got " + r.status);

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

  await req("/admin/reject", { method: "POST", body: { cls: "7C", nick: "Farid" },
                               headers: { "X-Teacher-Key": KEY } });

  r = await req("/admin/approve", { method: "POST", body: { cls: "9B", nick: "Aisha" },
                                    headers: { "X-Teacher-Key": KEY } });
  b = await r.json();
  check("approving updates every run that name posted", b.runsUpdated === 2, JSON.stringify(b));

  r = await req("/board?cls=9B");
  b = await r.json();
  const named = b.board.filter(x => x.nick === "Aisha");
  check("the approved name now appears", named.length === 2, JSON.stringify(b.board));
  check("the unjudged name still does not",
    JSON.stringify(b.board).indexOf("Rude One") < 0, JSON.stringify(b.board));

  /* the decision must carry to FUTURE runs, or the queue is unusable */
  r = await req("/score", { method: "POST", body: { ...good, nick: "Aisha", score: 60 } });
  b = await r.json();
  check("a later run by an approved name is approved on arrival", b.approved === 1,
    String(b.approved));

  r = await req("/admin/reject", { method: "POST", body: { cls: "9B", nick: "Rude One" },
                                   headers: { "X-Teacher-Key": KEY } });
  b = await r.json();
  check("rejecting works", b.status === -1, JSON.stringify(b));
  r = await req("/score", { method: "POST", body: { ...good, nick: "Rude One", score: 55 } });
  b = await r.json();
  check("a rejected name stays rejected on its next run", b.approved === -1, String(b.approved));
  r = await req("/board?cls=9B");
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
    ["a class code with markup in it", { cls: "<script>" }],
    ["an empty class code", { cls: "" }]
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

await test("rate limiting", async () => {
  let last;
  for (let i = 0; i < 45; i++) last = await req("/score", { method: "POST", body: good });
  check("a flood is eventually refused", last.status === 429, "got " + last.status);
  const other = await req("/score", { method: "POST", body: { ...good, cls: "7A" } });
  check("a different class is unaffected", other.status === 200, "got " + other.status);
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

  r = await req("/admin/clear", { method: "POST", body: { cls: "9B" }, headers: { "X-Teacher-Key": KEY } });
  b = await r.json();
  check("clear removes the rest of the class", b.cleared === 1, JSON.stringify(b));
  r = await req("/board?cls=9B");
  b = await r.json();
  check("board is empty after a clear", b.board.length === 0, String(b.board.length));
});

await test("an unset teacher key fails closed", async () => {
  env = { DB: makeDB(), ALLOWED_ORIGIN: "x" };            // no TEACHER_KEY at all
  const r = await req("/admin/clear", { method: "POST", body: { cls: "9B" }, headers: { "X-Teacher-Key": "" } });
  check("with no secret set, admin refuses rather than opening", r.status === 403, "got " + r.status);
});

await test("board query hygiene", async () => {
  await req("/score", { method: "POST", body: good });
  let r = await req("/board?cls=9B&limit=99999");
  let b = await r.json();
  check("an absurd limit is capped, not obeyed", r.status === 200 && b.board.length <= 100);
  r = await req("/board");
  check("a missing class code is refused", r.status === 400, "got " + r.status);
  r = await req("/board?cls=" + encodeURIComponent("' OR 1=1 --"));
  check("an injection attempt is refused by the class-code rule", r.status === 400, "got " + r.status);
});

console.log("\npassed: " + pass + "   failed: " + fails.length);
for (const f of fails) console.log("  - " + f);
process.exit(fails.length ? 1 : 0);
