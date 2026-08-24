# Samskara

Samskara records what your AI coding agent actually did, and makes it searchable.

Claude Code already writes a transcript of every session to `~/.claude/projects`. Those files are
local, per-machine, and hard to read. Samskara watches them, ships the sessions you opt into to a
server you run, and gives you a web UI to browse and search them — across projects, across
machines, across everyone on the team.

Capture is opt-in per folder. No session content leaves your machine until you run
`samskara enable` in a project — but `enable` itself talks to the server: it needs you already
logged in and the server reachable, and it exits 1 without changing anything if either is missing.

## What gets captured

- **The conversation** — prompts, replies, and the tool calls in between, including subagent branches.
- **Artifacts** — files the agent created or edited, stored as *before*, *after*, and the diff.
- **Git context** — the branch, commits, and pull requests a session touched.
- **Token usage** and session duration, per session.

## How it works

```
Claude Code                 samskara CLI                  server + web UI
~/.claude/projects/  ──▶  watcher (background)  ──POST──▶  Postgres + pgvector
   transcripts            reads enabled folders   /api/ingest      ▲
                                                                   │
                                                          browse & search at :8000
```

A `SessionStart` hook keeps the watcher alive: every time you start a Claude Code session, the hook
makes sure the background watcher is running. The watcher polls transcripts, keeps a per-session
checkpoint so it only sends what is new, and uploads artifacts in the background.

---

## Requirements

| | |
|---|---|
| [Bun](https://bun.sh) 1.2.19+ | package manager and test runner |
| Node 22+ | the CLI binary and the server both run on Node |
| Docker | Postgres + pgvector, and the server's DB tests |
| A GitHub OAuth app | web login |
| A GitHub org | login is gated to members of an org you seed |
| [worktrunk](https://worktrunk.dev) | only if you work on more than one branch at a time — see below |

---

## Run the server locally

### 1. Create a GitHub OAuth app

Go to **GitHub → Settings → Developer settings → OAuth Apps → New OAuth App** and set:

- **Homepage URL** — `http://localhost:8000`
- **Authorization callback URL** — `http://localhost:3000/api/auth/github/callback`

Generate a client secret. This is the only step nothing can do for you.

### 2. Run setup

```sh
bun run setup YOUR_GITHUB_ORG_SLUG
```

That installs dependencies, writes `.env` from `.env.example` with a freshly generated
`JWT_SECRET`, starts Postgres, migrates, seeds demo data, and registers your org. The first run
stops and tells you to paste the client id and secret from step 1 into `.env`; run it again after
you have.

Only members of a registered org can log in, which is what the org slug is for. Leave it off and
setup tells you how to add one later with `bun run seed:org YOUR_GITHUB_ORG_SLUG`; pass
`--no-auto-add` to that if you would rather grant membership by hand than have GitHub members
added on first login. Every login re-checks the user's current GitHub orgs and drops any samskara
org link GitHub no longer lists, so leaving an org on GitHub revokes access on the next login.

`bun run setup` is safe to re-run: it never rotates a secret that is already set, and it leaves a
database that already has projects alone.

The variables it writes:

| Variable | What it is |
|---|---|
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | from the OAuth app above — the only two you fill in |
| `JWT_SECRET` | generated for you |
| `DATABASE_URL` | `postgres://samskara:samskara@localhost:5433/samskara` (matches `docker-compose.yml`) |
| `PUBLIC_BASE_URL` | where the API is reachable, `http://localhost:3000` |
| `WEB_BASE_URL` | where the UI is, `http://localhost:8000` |
| `COOKIE_SECURE` | `false` for local http, `true` behind https |
| `JWT_EXPIRES_IN` | session lifetime, default `7d` |
| `VITE_API_BASE_URL` | API base the SPA calls, `http://localhost:3000` |

### 3. Start it

```sh
bun run dev               # API on :3000, web on :8000
```

Open http://localhost:8000 and sign in with GitHub.

### 4. Working on more than one branch at a time

Every branch talks to the same Postgres container. Sharing one database means a migration on one
branch rewrites the schema every other branch is reading, and two branches cannot run the app at
once. Worktrees created with [worktrunk](https://worktrunk.dev) get their own database and their
own port pair instead.

```sh
brew install worktrunk && wt config shell install    # cargo install worktrunk also works
wt switch --create feat/thing
```

Worktrunk puts new worktrees in a *sibling* directory by default (`../samskara.feat-thing`). If you
would rather have them inside the repo, where `.gitignore` already covers them, add this to your
own `~/.config/worktrunk/config.toml` — it is a personal setting, not a shared one:

```toml
worktree-path = "{{ repo_path }}/.worktrees/{{ branch | sanitize }}"
```

`.config/wt.toml` hooks do the rest, in about five seconds — copy your `.env` and `.seed/` in,
`bun install`, create `samskara_feat_thing`, migrate it, and seed it, restoring your local users
from `.seed/identity.json` with their uuids intact. `wt switch` asks to approve those commands the first time; add `--yes` in
a non-interactive session. `wt remove` drops the branch's database again.

Only `.env` and `.seed/` are carried over from your main checkout — `.worktreeinclude` at the repo
root is an allowlist, and a file has to be both gitignored and listed there to be copied. Everything else
(`node_modules`, `dist`, `.turbo`) is rebuilt, so no branch ever inherits another branch's stale
build. Start the Postgres container before creating a worktree; the hooks create a database inside
it but cannot start it.

**Signing in inside a worktree does not work,** and does not need to. A GitHub OAuth app matches
host *and* port exactly against its single registered callback on port 3000, so the redirect is
rejected. But cookies are not scoped by port and every worktree copies your `.env`, so a session
started at `http://localhost:8000` is already valid on `http://localhost:8252`. What makes it work is
`.seed/identity.json`, a gitignored snapshot of your users written by `bun run seed:capture` and
restored by `bun run seed`: it gives the worktree database a row with the same uuid your session
token names.

---

## Install the CLI

The CLI is not published to npm yet, so you install it from this repo:

```sh
bun install
bun run build --filter=@samskara/cli
cd packages/cli && npm link
```

That puts a `samskara` command on your PATH pointing at `packages/cli/dist/index.js`. Rebuild after
pulling changes; the link keeps working. To remove it later: `npm unlink -g @samskara/cli`.

If your server is not on the default ports, point the CLI at it:

```sh
export SAMSKARA_API_URL=https://samskara.example.com     # default http://localhost:3000
export SAMSKARA_WEB_URL=https://samskara.example.com     # default http://localhost:8000
```

### First run

```sh
samskara init             # log in, install the hook, start the watcher
cd ~/code/my-project
samskara enable           # start capturing this folder
```

`init` asks for a pairing code. Open the web UI, sign in, and pick **Pair the CLI → Generate code**
from the account menu. A code never expires but works only once. The token it returns is stored at
`~/.samskara/token` with mode `0600`.

---

## CLI reference

### Setup and account

| Command | What it does |
|---|---|
| `samskara init` | Log in, install the Claude Code `SessionStart` hook, start the watcher. Safe to re-run. |
| `samskara login [--code CODE]` | Pair with the web UI and store a CLI token. |
| `samskara logout` | Stop the watcher and delete the stored token. |

### Choosing what to capture

| Command | What it does |
|---|---|
| `samskara enable [path]` | Register this folder with the server and start capturing it (defaults to the current directory). |
| `samskara enable --all` | Also send sessions recorded *before* you enabled it. |
| `samskara enable --sync-from 2026-07-01` | Only send sessions started after that date. |
| `samskara disable [path]` | Stop capturing locally. Sessions already uploaded stay on the server. |

`enable` calls `POST /api/projects` to register the folder, so it needs a stored login and a
reachable server — with either missing, it exits 1 and writes nothing. By default it also starts
the clock now, so turning capture on for an old project does not retroactively upload years of
history. Re-running plain `enable` on an already-enabled folder does not move the cutoff — pass
`--all` or `--sync-from` for that — but it can still rewrite the stored `projectId` in
`projects.json` if the server now resolves this folder to a different project (for example, once
its GitHub org gets seeded).

### Day to day

| Command | What it does |
|---|---|
| `samskara status` | Projects, capture state, last sync time, watcher PID. Start here when something looks off. |
| `samskara logs [-f]` | Pretty-print the watcher log. `-f` streams new lines. |
| `samskara restart` | Stop the watcher and start a fresh one. |
| `samskara replay SESSION_ID` | Delete a session server-side and locally, then re-capture it from scratch. |

### Hooks and the watcher

| Command | What it does |
|---|---|
| `samskara install-hooks` | Install the `SessionStart` hook by hand. |
| `samskara uninstall-hooks` | Remove it. |
| `samskara watch` | Start the watcher daemon directly. |
| `samskara watch --foreground` | Run the capture loop in this terminal — useful for debugging. |

`--verbose` on any command turns on debug logging.

### Local state

Everything the CLI stores lives in `~/.samskara` (override the whole directory with `SAMSKARA_HOME`):

| Path | Contents |
|---|---|
| `token` | CLI access token, mode `0600` |
| `projects.json` | which folders are enabled, and since when |
| `state.json` | per-session ingest checkpoints |
| `artifacts.json`, `artifact-queue.json` | artifact checkpoints and pending uploads |
| `watch.pid` | watcher process id |
| `logs/current.log` | watcher log, rotated daily |

---

## Using the web UI

| Route | What you get |
|---|---|
| `/projects` | Every project you can read — session count, last activity, last session title |
| `/sessions` | Session index with search and filters |
| `/sessions/:id` | One session: Conversation, Timeline, Tool Calls, and Artifacts tabs, with subagent branches you can expand |
| `/sync-status` | Each project you can read, paired with every user who belongs to it and when they last synced it — sortable by any column, filterable by user and project |

Filters live in the query string, so any view you are looking at is a link you can paste to a
teammate, and Back/Forward work the way you expect.

Search supports a small deliberate grammar:

```
auth refactor            both words
"rate limit"             exact phrase
deploy -staging          exclude a word
redis OR valkey          either
migrat*                  prefix match
```

Filters you can combine with it: `project`, `user`, `repo`, `branch`, `pr`, `commit`,
`range` (`hour` / `today` / `week` / `month` / `custom` with `from` and `to`), and
`sort` (`recent`, `oldest`, `tokens`, `project`, `relevance`).

---

## Repo layout

| Package | What it holds |
|---|---|
| `@samskara/core` | Shared types, the collector framework (`SourceAdapter` + Claude plugin), the logging factory |
| `@samskara/cli` | The `samskara` binary — pairing, capture opt-in, the watcher |
| `@samskara/server` | Hono API on Node, Drizzle + postgres-js + pgvector |
| `@samskara/web` | Vite + React + Tailwind UI |

### API surface

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | none | liveness |
| GET | `/api/auth/github/start` | none | begin OAuth |
| GET | `/api/auth/github/callback` | none | verify state, org-gate, set session cookie |
| GET | `/api/auth/me` | web / cli | current user |
| POST | `/api/auth/logout` | web | clear the session cookie |
| POST | `/api/auth/cli-code` | web | mint a pairing code |
| POST | `/api/auth/cli-exchange` | none | redeem a code for a CLI token |
| GET | `/api/projects` | web | projects with session counts |
| POST | `/api/projects` | cli | find or create the project for a folder; org-owned when its GitHub org is registered and the caller is a member |
| GET | `/api/sync-status` | web | the projects the caller may read, each member of them, and that member's own last-synced time |
| GET | `/api/sessions` | web | session list, search and filters |
| GET | `/api/sessions/:id` | web | one session with messages, tools, subagents, tokens |
| GET | `/api/sessions/:id/artifacts` | web | artifacts for a session |
| DELETE | `/api/sessions/:id` | cli | delete a session (used by `replay`) |
| POST | `/api/ingest` | cli | flush a captured session |
| POST | `/api/artifacts` | cli | upload an artifact |
| GET | `/api/artifacts/:id` | web | artifact metadata and diff |
| GET | `/api/artifacts/:id/raw?which=base\|current` | web | the artifact bytes |

Tokens are audience-scoped (`aud: web` or `aud: cli`) and checked per route.

---

## Development

```sh
bun run dev          # API + web, watch mode
bun run build        # build every package
bun run typecheck    # every package, plus the e2e project
bun run lint         # biome check ., including the DB naming rule
bun run format       # biome format --write .
bun run test         # every package's unit tests
bun run e2e          # Playwright, on a throwaway database it creates and drops
bun run e2e:ui       # the same suite in Playwright's UI mode
bun run cli -- status   # run the CLI from source, without linking
```

Database helpers:

```sh
bun run stack:up / stack:down          # Postgres container
bun run db:generate                    # generate a migration from schema.ts
bun run db:migrate                     # bring a database fully up to date
bun run db:verify                      # read-only: assert it already is
```

`db:migrate` is the only command that touches a database's shape. It runs drizzle-kit's migrations
and then every post-migrate step in `packages/server/src/db/steps.ts` — work migrations cannot
carry, because `create index concurrently` is rejected inside a migration's transaction. Today that
is the full-text search indexes. Steps are idempotent and run on every migrate, so a database is
never left half-set-up; skipping them leaves a schema-correct database whose every search
sequentially re-tokenizes every message, which reads as the API hanging rather than as a missing
step.

To add one: write the module next to `steps.ts`, export a `MigrationStep` with an idempotent `run`
and a read-only `verify`, and list it in `MIGRATION_STEPS`.

Every table and column name in the database uses camelCase. A Biome plugin
(`packages/server/src/db/naming.grit`) enforces it against `packages/server/src/db/schema.ts`, so
`bun run lint` fails the build when a new column or table name uses snake_case.

The plugin reads TypeScript, not SQL, so it sees a name only once `schema.ts` declares it. A
hand-written migration that adds a column without touching `schema.ts` is not checked — keep the
schema the source of truth and generate migrations from it wherever you can.

The server's test suite starts a real `pgvector/pgvector:pg16` container via testcontainers and runs
the migrations against it, so schema and auth are covered end to end. Those tests skip themselves
when Docker is not available.

### Logging

Every package logs NDJSON through `createLogger` from `@samskara/core` (pino underneath). Level
comes from `LOG_LEVEL`, defaulting to `info` in production and `debug` elsewhere. `token`,
`authorization`, `password`, and `secret` are redacted from every line. Each API request gets a
`reqId` that is echoed back on the response, so a log line and a request can always be tied together.
