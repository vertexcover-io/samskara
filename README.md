# Samskara

[![CI](https://github.com/vertexcover-io/samskara/actions/workflows/ci.yml/badge.svg)](https://github.com/vertexcover-io/samskara/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/vertexcover-io/samskara?label=release)](https://github.com/vertexcover-io/samskara/releases/latest)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Samskara records what your AI coding agent actually did, and makes it searchable.

Claude Code already writes a transcript of every session to `~/.claude/projects`. Those files are
local, per-machine, and hard to read. Samskara watches them, ships the sessions you opt into to a
server you run, and gives you a web UI to browse and search them — across projects, across
machines, across everyone on the team.

Capture is opt-in per folder: no session content leaves your machine until you run
`samskara enable` in a project.

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

## Requirements

- [Bun](https://bun.sh) 1.2.19+ — package manager and test runner
- Node 22+ — the CLI binary and the server both run on Node
- Docker — Postgres + pgvector
- A GitHub OAuth app, and a GitHub org whose members are allowed to log in

## Run the server

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
you have. It is safe to re-run: it never rotates a secret that is already set, and it leaves a
database that already has projects alone.

Only members of a registered org can log in. Leave the slug off and setup tells you how to add one
later with `bun run seed:org YOUR_GITHUB_ORG_SLUG`. Every login re-checks the user's current GitHub
orgs, so leaving an org on GitHub revokes access on the next login.

The variables setup writes:

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

## Install the CLI

The CLI is not on npm. Every release attaches an installable tarball to its
[GitHub release](https://github.com/vertexcover-io/samskara/releases), so install the latest one
directly:

```sh
npm i -g https://github.com/vertexcover-io/samskara/releases/download/vVERSION/samskara-cli-VERSION.tgz
```

Replace `VERSION` with the release you want, for example `v0.1.0` and `0.1.0`. The tarball carries
`@samskara/core` inside it, so nothing else has to be fetched from a registry. It needs Node 22+.
To remove it later: `npm uninstall -g @samskara/cli`.

To upgrade, run `samskara upgrade`. It asks GitHub for the newest release, and if that is newer
than the CLI you are running it installs that release's tarball over this one — the same
`npm i -g TARBALL` as above, so it needs write access to the global npm prefix.
`samskara upgrade --check` only reports whether a newer release exists. Either way, run
`samskara restart` afterwards so the running watcher picks up the new build.

### From a checkout instead

Working on the CLI itself, or want an unreleased build:

```sh
bun install
bun run build --filter=@samskara/cli
cd packages/cli && npm link
```

That puts a `samskara` command on your PATH pointing at `packages/cli/dist/index.js`. Rebuild after
pulling changes; the link keeps working. To remove it later: `npm unlink -g @samskara/cli`.

### First run

```sh
samskara init             # choose a server, log in, install the hook, start the watcher
cd ~/code/my-project
samskara enable           # start capturing this folder
```

`init` first asks which server to talk to, offering the local defaults:

```
Samskara server URL [http://localhost:3000]:
Samskara web URL [http://localhost:8000]:
```

Press Enter to keep a default. The answers are saved to `~/.samskara/config.json` and every later
command uses them, so this is asked once. Pass `--server URL` and `--web URL` to skip the questions,
and re-run `samskara init` to point the CLI somewhere else. `SAMSKARA_API_URL` and
`SAMSKARA_WEB_URL` still override the saved file for a single command; when either is set, `init`
leaves that URL alone rather than asking. `samskara status` prints both URLs currently in use.

Then `init` asks for a pairing code. Open the web UI, sign in, and pick **Pair the CLI → Generate code**
from the account menu. A code never expires but works only once. The token it returns is stored at
`~/.samskara/token` with mode `0600`.

## CLI reference

| Command | What it does |
|---|---|
| `samskara init` | Choose the server, log in, install the Claude Code `SessionStart` hook, start the watcher. Safe to re-run. |
| `samskara init --server URL --web URL` | Same, without the questions. |
| `samskara login [--code CODE]` | Pair with the web UI and store a CLI token. |
| `samskara logout` | Stop the watcher and delete the stored token. |
| `samskara enable [path]` | Register this folder with the server and start capturing it (defaults to the current directory). |
| `samskara enable --all` | Also send sessions recorded *before* you enabled it. |
| `samskara enable --sync-from 2026-07-01` | Only send sessions started after that date. |
| `samskara disable [path]` | Stop capturing locally. Sessions already uploaded stay on the server. |
| `samskara status` | Server and web URLs, projects, capture state, last sync time, watcher PID. Start here when something looks off. |
| `samskara logs [-f]` | Pretty-print the watcher log. `-f` streams new lines. |
| `samskara restart` | Stop the watcher and start a fresh one. |
| `samskara upgrade [--check]` | Install the newest GitHub release over this one; `--check` only reports whether one exists. |
| `samskara replay SESSION_ID` | Delete a session server-side and locally, then re-capture it from scratch. |
| `samskara search [QUERY]` | Search captured sessions from the terminal and print each hit's URL. |
| `samskara install-hooks` / `uninstall-hooks` | Install or remove the `SessionStart` hook by hand. |
| `samskara watch [--foreground]` | Start the watcher daemon directly; `--foreground` runs the loop in this terminal. |

`--verbose` on any command turns on debug logging.

`enable` registers the folder with the server, so it needs a stored login and a reachable server —
with either missing it exits 1 and writes nothing. By default it starts the clock now, so turning
capture on for an old project does not retroactively upload years of history.

`samskara search` takes the same filters as the web UI's `/sessions` page and the same query grammar
(see [Using the web UI](#using-the-web-ui)): `--project`, `--user`, `--repo`, `--branch`, `--pr`,
`--commit`, `--range` (`--from`/`--to` for `custom`), `--tz`, `--sort`, `--page`, `--limit`.
`--project` and `--repo` take a name or an id — an ambiguous or unrecognized name fails rather than
guessing, and lists the closest known names. `--here` fills project, repo and branch from the current
checkout (explicit flags win over it). `--first` keeps only the top hit; `--url` and `--json` print
machine-readable output instead of the default table; `--open` opens the top hit in a browser.

Everything the CLI stores lives in `~/.samskara` — the token, which folders are enabled, per-session
ingest checkpoints, cached `search` filter names, the watcher pid, and `logs/current.log`. Override
the whole directory with `SAMSKARA_HOME`, or name an install with `SAMSKARA_PROFILE`: `default` keeps
`~/.samskara`, any other name gets `~/.samskara-NAME` and its own SessionStart hook, so two installs
on one machine never share a token, a server URL or the watcher pid. `samskara status` prints which
profile you are looking at.

## Using the web UI

| Route | What you get |
|---|---|
| `/projects` | Every project you can read — session count, last activity, last session title |
| `/sessions` | Session index with search and filters |
| `/sessions/:id` | One session: Conversation, Timeline, Tool Calls, and Artifacts tabs, with subagent branches you can expand |
| `/sync-status` | Each project you can read, paired with every user who belongs to it and when they last synced it |

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

The same query and filters are available from the terminal with `samskara search` (see
[CLI reference](#cli-reference)).

## Development

| Package | What it holds |
|---|---|
| `@samskara/core` | Shared types, the collector framework (`SourceAdapter` + Claude plugin), the logging factory |
| `@samskara/cli` | The `samskara` binary — pairing, capture opt-in, the watcher |
| `@samskara/server` | Hono API on Node, Drizzle + postgres-js + pgvector |
| `@samskara/web` | Vite + React + Tailwind UI |

```sh
bun run dev          # API + web, watch mode
bun run build        # build every package
bun run typecheck    # every package, plus the e2e project
bun run lint         # biome check ., including the DB naming rule
bun run format       # biome format --write .
bun run test         # every package's unit tests
bun run e2e          # Playwright, on a throwaway database it creates and drops
bun run cli -- status   # the CLI from source, on its own `dev` profile
```

Database helpers:

```sh
bun run stack:up / stack:down          # Postgres container
bun run db:generate                    # generate a migration from schema.ts
bun run db:migrate                     # bring a database fully up to date
bun run db:verify                      # read-only: assert it already is
```

`db:migrate` is the only supported way to change a database's shape — it runs drizzle-kit's
migrations and then the post-migrate steps in `packages/server/src/db/steps.ts` (today, the
full-text search indexes, which cannot be built inside a migration's transaction).

See [CLAUDE.md](CLAUDE.md) for the contributor detail: working on several branches at once, the
database naming rule, the seed/identity snapshot, and the logging conventions.

## Releases

Every package carries the same version, so one tag names one state of the whole repo. Cutting a
release is two commands:

```sh
bun run release:version patch    # or minor, major, or an explicit 1.4.0
git push origin master --follow-tags
```

`release:version` refuses a dirty tree, writes the version into the root manifest and all four
packages, commits and tags it, and stops there — `--no-git` bumps the files only. Pushing the tag
runs `.github/workflows/release.yml`, which re-checks the tag against the manifests, runs lint,
typecheck and the tests, builds the CLI tarball and creates the GitHub release with it attached.

Only the CLI ships an artifact; the server and web UI are deployed from source. To build the
tarball without releasing anything, `bun run release:pack` writes `dist/samskara-cli-VERSION.tgz`.

The CLI depends on `@samskara/core` as `workspace:*`, which means nothing outside this repo, and
core is never published, so the tarball carries core inside it as an npm
[bundled dependency](https://docs.npmjs.com/cli/configuring-npm/package-json#bundledependencies).
One wrinkle: npm leaves an *empty* directory for every dependency a bundled package declares, so
the bundled copy of core declares none and core's dependencies are hoisted into the CLI's own list,
where bundled core resolves them by walking up out of its directory.

## License

[MIT](LICENSE) © Vertexcover
