# worker/ — the leaderboard service

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

`deploy-worker.bat` is safe to re-run. The database is auto-provisioned on the
first deploy (`database_id` is deliberately absent from `wrangler.jsonc`), and
the schema is idempotent.

## Endpoints

| Route | Method | Who | What |
|---|---|---|---|
| `/health` | GET | anyone | liveness |
| `/score` | POST | the app | submit one run |
| `/board?cls=9B&limit=20` | GET | the app | top scores for a class |
| `/admin/delete` | POST | teacher | remove one row by id |
| `/admin/clear` | POST | teacher | empty one class board |
| `/admin/pending` | POST | teacher | names awaiting a decision |
| `/admin/approve` | POST | teacher | let a name be seen |
| `/admin/reject` | POST | teacher | keep a name hidden for good |

Teacher routes need an `X-Teacher-Key` header matching the `TEACHER_KEY` secret.
**If that secret has never been set, they refuse rather than defaulting to open.**

### POST /score

```json
{ "cls": "9B", "nick": "Aisha", "correct": 20, "wrong": 2,
  "chain": 8, "level": "secure", "score": 30 }
```

**Nicknames are free text and therefore moderated** (SPEC 19.3, revised
2026-08-25 on the teacher's ruling; an earlier version composed them from word
lists so a rude one was impossible to type).

The safety property is **not a filter, it is a gate**: `GET /board` never
returns a name that has not been approved. Not masked, not filtered on the
client, not sent at all. The score ranks immediately, because holding a score
hostage to a teacher's attention would make the board useless.

**A name is judged once per class, not once per run.** Approving *Aisha* in 9B
updates every run she has posted and every run she posts afterwards. Without
that, a teacher approves the same thirty names every lesson, which is how a
moderation queue stops being used.

### Moderating

| Route | Body | Effect |
|---|---|---|
| `/admin/pending` | `{cls}` | names waiting, grouped by name with a run count |
| `/admin/approve` | `{cls, nick}` | that name becomes visible, past and future |
| `/admin/reject` | `{cls, nick}` | that name never becomes visible |

A rejected student's **scores still count and still rank**; only the name stays
hidden.

## What is validated, and what is not

Scores cannot be trusted and **that is unfixable, not merely unfixed** (SPEC
19.4). The run happens in a browser and the source is public. So the worker
rejects the *impossible* rather than pretending to verify the plausible:

- arithmetic that could not have happened (score above `correct x maxMultiplier - wrong x penalty`)
- more items than sixty seconds physically allows
- a chain longer than the number of correct answers
- names that are empty, over 16 characters, or not a string; class codes that are not plain alphanumerics
- more than 40 submissions for one class in 60 seconds

The bound is deliberately loose. It exists to reject 999999, not to second-guess
a fast student, and a legitimately excellent run is tested to still pass.

**Rate limiting counts rows in the `runs` table rather than tracking IP
addresses**, so that no request metadata has to be stored to make it work.

## Testing

```
node worker/test.mjs
```

62 assertions. Drives the real worker module against a real SQLite database
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
| The teacher password | `npx wrangler secret put TEACHER_KEY` |
| `.dev.vars` | git-ignored, stays on the machine |
| `.wrangler/` | git-ignored |

`wrangler.jsonc` holds a worker name and an allowed origin. Both are public
information and safe in a public repo. Nothing else belongs in it.

## What is deliberately NOT stored

Real names, school identifiers, misconception counters, practice history, IP
addresses. SPEC 19.3 is the list, and it is a decision rather than an
implementation detail.
