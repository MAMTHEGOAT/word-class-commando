# worker/: the leaderboard service

Governed by **SPEC section 19**. Read that before changing anything here.

Holds challenge-mode high scores only. Not a gradebook, not a login, not a store
of practice data.

## The one rule that matters

**The app must work completely with this service unreachable.** If you find
yourself writing a student-facing error message about the network, stop: the
requirement is a silent fallback to a local personal best, not a good error
message.

## Deploying

The site and the service deploy **separately**. `git push` publishes the app to
GitHub Pages; it does not touch this. From this folder:

```
npx wrangler login          # once, ever
deploy-worker.bat           # or the two commands it runs
npx wrangler secret put TEACHER_KEY   # once, sets the teacher password
```

**`TEACHER_KEY` is the NAME and never changes.** The command then prints
`Enter a secret value:` and *that* is where the password goes. Typing the
password in place of the name creates a secret with the wrong name, leaves
`TEACHER_KEY` unset, and puts the password somewhere it is not secret: names are
listed in plain text by `wrangler secret list` and by the Cloudflare dashboard.
This happened on 2026-08-25. Check with `npx wrangler secret list`, which must
show exactly `TEACHER_KEY`.

**Type the value at the prompt rather than pasting it.** A paste often carries a
trailing space or newline, the comparison is exact, and nothing typed into the
teacher page would then ever match.

`deploy-worker.bat` is safe to re-run. `database_id` in `wrangler.jsonc` is an
identifier, not a credential, and the schema is idempotent.

The board and the submit work only from the live site: CORS is locked to
`https://mamthegoat.github.io`, so a local copy of the app (a memory stick,
`serve.ps1`) shows "The board will not load right now". That is expected, not an outage.

## Endpoints

| Route | Method | Who | What |
|---|---|---|---|
| `/health` | GET | anyone | liveness |
| `/score` | POST | the app | submit one run |
| `/board?board=punc&limit=20` | GET | the app | one board (`wc`, `punc`, `tense`, `tech`, `texp`, `ult`), THIS CYCLE: each name once, at its best |
| `/board?scope=all` | GET | the app | the same board, all time: the hall of fame |
| `/cycle` | GET | anyone | which cycle, which week, which school day, when it resets |
| `/admin/board` | POST | teacher | every row with its real name and decision |
| `/admin/delete` | POST | teacher | remove one row by id |
| `/admin/clear` | POST | teacher | `{all: true}` or `{cls}`: delete the runs AND the name decisions in that scope |
| `/admin/pending` | POST | teacher | names awaiting a decision |
| `/admin/approve` | POST | teacher | let a name be seen |
| `/admin/reject` | POST | teacher | keep a name hidden for good |
| `/admin/names` | POST | teacher | every name on the board, with the year group it counts under |
| `/admin/assign` | POST | teacher | move a name, and everything it has posted, into a year group |
| `/admin/cycles` | POST | teacher | `{}` lists the cycles; `{cycle: n}` gives that cycle's winners |
| `/admin/cycle` | POST | teacher | `{week: "A"|"B"}`: say which week this one is, after a break |

Teacher routes need an `X-Teacher-Key` header matching the `TEACHER_KEY` secret.
**If that secret has never been set, they refuse rather than defaulting to open.**

### POST /score

```json
{ "nick": "Aisha", "cls": "Y8", "correct": 20, "wrong": 2, "chain": 8,
  "level": "secure", "score": 30, "board": "wc", "ver": "v0.58" }
```

`cls` is the **year group** (v0.50): one of `Y7`, `Y8`, `Y9`, `KS4`, `OTHER`, and
anything else is refused. A run that arrives without one lands under `ALL`, which
is where every run posted before v0.50 sits and where an app that has not been
updated still posts. The list is closed because the app is the only client, so an
open field buys nothing and lets a typo create a sixth year group nobody can see
is wrong.

The reply carries **two ranks**: `rank` across every year, which is the board the
app opens on, and `yearRank` within the year group the run was filed under. Both
are counted **inside the current cycle** since v0.58, because that is the board
the pupil is about to look at. Alongside them: `best` (this cycle), `allBest`
(ever), `record` (this run beat every score ever set on that board) and `cycle`
(where the fortnight is).

`ver` is the app version, and it is a **label**: anything malformed becomes no
version rather than a bad request, because nobody should lose a score over a
cosmetic field. An app that sends none still posts.

**Nicknames are free text and therefore moderated** (SPEC 19.3, revised
2026-08-25 on the teacher's ruling; an earlier version composed them from word
lists so a rude one was impossible to type).

The safety property is **not a filter, it is a gate**: `GET /board` never
returns a name that has not been approved. Not masked, not filtered on the
client, not sent at all. The score ranks immediately, because holding a score
hostage to a teacher's attention would make the board useless.

**A name is judged once per year group, not once per run**, and spellings that
differ only in capitals or spaces ("Rude", "RUDE", "R u d e") are one name.
Approving *Aisha* in Year 8 updates every run she has posted and every run she
posts afterwards. Without that, a teacher approves the same thirty names every
lesson, which is how a moderation queue stops being used.

Per YEAR GROUP is deliberate (v0.50, Michael's ruling): a Year 7 Dragon and a
Year 9 Dragon are two pupils, so they are two lines on the board and two
decisions. It costs a second approval for a repeated name and it stops one
pupil's score hiding another's.

### Moderating

| Route | Body | Effect |
|---|---|---|
| `/admin/pending` | `{cls}` | names waiting, grouped by name with a run count |
| `/admin/approve` | `{cls, nick}` | that name becomes visible, past and future |
| `/admin/reject` | `{cls, nick}` | that name never becomes visible |

A rejected student's **scores still count and still rank**; only the name stays
hidden.

### Filing the old board by year group

The board ran for a year before year groups existed, so everything already on it
sits under `ALL`. `/admin/names` lists every name with the year it counts under;
`/admin/assign` takes `{cls, nick, year}` and moves that name, and every run it
has ever posted, into `year`.

The unit is the **name**, not the run: a pupil is one pupil, filing nine runs one
at a time is how a tool stops being used, and leaving eight behind would put the
same nickname on the board twice. If the destination year already holds that
name the two become one, which is the teacher asserting they are the same pupil
rather than a collision to refuse. The decision already made in the destination
wins, so a name approved there does not go back into the queue and a rejected one
does not arrive showing.

### The cycle

Michael's school runs a two-week timetable and he rewards the top of each skill
and year group every cycle, so **the student board is the cycle running now** and
it empties at local midnight between the Sunday and the Monday. Cycle 1 began
Monday 14 September 2026, 00:00 in Phuket.

Two things about this are deliberate and easy to undo by accident:

**Boundaries are rows in the `cycles` table, not arithmetic on an offset.** A
cycle that has happened is a fact about the past. Computed from an anchor, moving
that anchor in November would rewrite who won in September, which is the one
thing this feature exists to record. Rows are created lazily, by the first
request after a boundary passes; nothing runs on a timer.

**The offset is written down.** This worker runs in UTC and Michael's midnight is
seven hours earlier. `TZ_OFFSET` is a constant here and in the app. Thailand has
no daylight saving, which is what makes a fixed offset honest; anywhere that has
it, this constant is a bug.

`/admin/cycle` with `{week: "A"}` or `{week: "B"}` exists because a one-week
break offsets the real timetable. It closes the cycle in progress at the new
boundary and opens a new one, which is what a break does: cycle 4 ended early and
cycle 5 is the one you are in. **Finished cycles are not touched**, so their
winners do not change.

`/admin/cycles` with `{cycle: n}` returns one winner per board per year group,
which is the list a teacher reads out when handing out rewards. Winners are
returned with their real nicknames whatever their moderation state, because a
teacher giving a reward needs to know who it is.

### Two public boards, and only two

`GET /board` serves `scope=cycle` (the default) and `scope=all` (the hall of
fame, with `created` and `ver` on every row). It does **not** accept a cycle
number. A past cycle is served only by `/admin/cycles`, behind the key.

That is a property of the route and not of the app, for the same reason an
unapproved name is: a rule the client enforces is a rule anybody can edit.

## What is validated, and what is not

Scores cannot be trusted and **that is unfixable, not merely unfixed** (SPEC
19.4). The run happens in a browser and the source is public. So the worker
rejects the *impossible* rather than pretending to verify the plausible:

- arithmetic that could not have happened (score above `correct x maxMultiplier`
  minus the wrong-answer penalty, counting at most 5 of it, since the app floors a
  run at -5)
- more items than the board's run length physically allows
- a chain longer than the number of correct answers
- names that are empty (invisible characters are stripped first), over 16 characters, or not a string; class codes that are not plain alphanumerics
- more than 240 submissions app-wide in 60 seconds (answered with 429, which the app queues and retries)

The bound is deliberately loose. It exists to reject 999999, not to second-guess
a fast student, and a legitimately excellent run is tested to still pass.

**Rate limiting counts rows in the `runs` table rather than tracking IP
addresses**, so that no request metadata has to be stored to make it work.

## Testing

```
node worker/test.mjs
```

117 assertions. Drives the real worker module against a real SQLite database
through a small D1 shim, so the SQL is executed rather than eyeballed. The shim
implements only the four D1 calls the worker makes; if the worker starts using
more of the D1 API, the shim has to grow with it, and a missing method throws
loudly rather than passing quietly.

`wrangler dev` would be better and is not available in the build sandbox, whose
package registry does not serve wrangler. Run it locally if you want the real
runtime.

## Secrets: what must never be committed

The repository is **public**.

| Never commit | Where it goes instead |
|---|---|
| Cloudflare API tokens | `wrangler login` |
| The teacher password | `npx wrangler secret put TEACHER_KEY`, entered at the **value** prompt, never as the name |
| `.dev.vars` | git-ignored, stays on the machine |
| `.wrangler/` | git-ignored |

`wrangler.jsonc` holds a worker name and an allowed origin. Both are public
information and safe in a public repo. Nothing else belongs in it.

## What is deliberately NOT stored

Real names, school identifiers, misconception counters, practice history, IP
addresses. SPEC 19.3 is the list, and it is a decision rather than an
implementation detail.
