# worker/ — the leaderboard service

**Nothing here is built yet.** This folder and its rules exist before the code, so the
rules are set rather than discovered. Governed by **SPEC section 19**. Read that first.

## The one rule that matters

**The app must work completely with this service unreachable.** If you find yourself
writing a student-facing error message about the network, stop: the requirement is a
silent fallback to a local personal best, not a good error message.

## What this is

A Cloudflare Worker plus a D1 database, free plan, holding challenge-mode high scores
only. Not a gradebook, not a login, not a store of practice data.

- `POST /score`  — one run: nickname, score, correct, wrong, chain, level, class code
- `GET  /board`  — top N for a class code
- teacher routes behind a shared secret: delete a row, clear a board

## Deploying

The site is on GitHub Pages and does **not** deploy this. It is a separate step:

```
npx wrangler login      # once, opens a browser
npx wrangler deploy     # or double-click deploy-worker.bat
```

## Secrets: what must never be committed

The repository is **public**. Before adding any file here, check it against this list.

| Never commit | Where it goes instead |
|---|---|
| Cloudflare API tokens | `wrangler login`, or `wrangler secret put` |
| The teacher shared secret | `npx wrangler secret put TEACHER_KEY` |
| `.dev.vars` (local secrets file) | git-ignored, stays on the machine |
| `.wrangler/` (local state) | git-ignored |

`wrangler.toml` holds a database id and an account id. Those are identifiers, not
credentials, and are safe in a public repo, but do not put anything else in there.

## What is deliberately NOT stored

Real names, school identifiers, misconception counters, practice history, IP addresses.
SPEC 19.3 is the list and it is a decision, not an implementation detail.
