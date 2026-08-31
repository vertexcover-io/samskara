# Samskara

Bun + Turborepo monorepo. Packages: `core` (ingest/domain), `server` (Hono + Drizzle + Postgres),
`web` (React + Vite), `cli`. Tests are vitest; lint/format is biome. TDD — write the test first.

## Subagents — parallel by default

**The main conversation is a coordinator, not a worker.** Reserve it for synthesis, judgment,
and decisions; delegate data-gathering, exploration, and well-specified implementation to
subagents. Independent dispatches go out in one batch — sequential fan-out of independent work
is the anti-pattern, in every phase (exploration, planning, implementation, verification).

- **Delegate**: "how does X work", file/area surveys, pattern discovery, writing tests to a
  spec, implementing a well-scoped change. **Do directly**: anything whose output feeds the
  very next judgment call, and single quick reads.
- **Route by dispatch shape.** Two subagent mechanisms exist; the shape of the work picks
  the lane:
  - **Harness-native Task tool — the default.** Bounded work that fits one prompt and
    returns one answer: exploration, surveys, research, test-writing waves, spec'd
    implementation chunks. Fire-and-forget, batched in parallel, nothing to clean up.
  - **Herdr-spawned panes — for work with a lifespan or an audience.** Long builds the
    owner should be able to watch or join mid-run (takeover), cross-model deliberation,
    lanes that must outlive the current session or take sequential briefings, and anything
    likely to need interactive unblocking (a live pane can be read, re-prompted, and have
    its questions answered in place).
- **Detect the environment, then go.** The same rule serves both setups: run
  `test "${HERDR_ENV:-}" = 1` once before dispatching. Inside Herdr, long-lifespan work
  goes to a sibling pane via the `herdr` skill (AGENTS.md routes to it; read it before any
  herdr command). Outside Herdr, everything routes through the harness Task tool — the
  dispatch-shape rule above still applies, the pane lane just isn't available.
- **GLM-5.3 is the default, MiniMax the second lane.** This machine runs opencode subagents
  under two coding plans — default to `zai-coding-plan/glm-5.3` for almost everything
  (judgment, design, roadmaps, synthesis, and implementation too); reach for
  `minimax-coding-plan/MiniMax-M3` when you want a genuinely independent second opinion on
  the same question, or a second parallel lane and GLM is already carrying the main one.
  Pin the model on every subagent: in opencode, a herdr pane takes `--model` at
  `agent start`; an unpinned dispatch inherits whatever context it landed in.
- **Herdr hygiene** (inside Herdr only): number the tabs you create (`0 mc / …`, `1 …`) as
  breadcrumbs, and **close what you opened** when its work is done — tabs and panes you
  created, not the user's. Long-running shared infrastructure (the dev stack) is the
  exception: it stays until the owner says stop.
- **Test-first waves for TDD.** When a task is big enough to wave: one subagent writes the
  failing tests (given requirements and patterns, no implementation context), the gate runs
  them red, then implementation subagents get the failing tests. The information boundary is
  the enforcement — that is why the dispatches are separate. Small or inherently sequential
  tasks skip the wave and just do TDD inline.

## New machine

```bash
bun run setup YOUR_GITHUB_ORG_SLUG
bun run dev
```

`setup` installs, writes `.env` with a generated `JWT_SECRET`, starts Postgres, migrates, seeds and
registers the org. It stops on the first run to have you paste the GitHub OAuth client id and
secret into `.env` — the only manual step. Re-running is safe: it never rotates a secret that is
already set and leaves a database that already has projects alone. Worktrees additionally need
`brew install worktrunk && wt config shell install`.

`.env` is gitignored, so nothing here is shared between machines: ports and database names are all
derived locally.

## Worktrees

**Always create worktrees with the `create-worktree` skill, never with `git worktree add` and never
with the harness `using-git-worktrees` skill.**

`wt` (worktrunk) drives creation, and `.config/wt.toml` hooks give each worktree its own Postgres
database and its own port pair. That isolation is the whole point: every branch shares one Postgres
container, so without a per-branch database a migration on one branch rewrites the schema every
other branch is reading, and two branches cannot run the app at once.

The rule that matters: **`.env` must be a real file in each worktree, never a symlink to the main
checkout's `.env`.** A symlink means one `DATABASE_URL` for every branch, and editing it in a
worktree silently edits the main checkout. `bun run wt:setup` replaces a symlink with a copy.

| Command | What it does |
|---|---|
| `wt switch --create feat/thing` | Creates the worktree and runs the hooks (copy env, install, per-branch db, migrate, seed) |
| `wt list` | Worktrees and their status |
| `wt remove` | Removes the worktree; the `pre-remove` hook drops its database |
| `bun run wt:setup` | Re-runs env + database setup for the current worktree (idempotent) |
| `bun run wt:teardown` | Drops only the current worktree's database |

Only `.env` crosses over from the main checkout: `.worktreeinclude` is an allowlist and a file must
be both gitignored and listed there. `node_modules`, `dist` and `.turbo` are rebuilt per worktree,
Where worktrees land is a personal setting
(`worktree-path` in `~/.config/worktrunk/config.toml`), so do not assume `.worktrees/`; read
`git worktree list` instead.

Each worktree's `.env` records `WT_SLUG` and `WT_PORT_OFFSET`. The offset is derived from the branch
name, so ports are stable across runs; server is `3000 + offset`, web is `8000 + offset`. Run
`bun run wt:setup` and it prints the db url, api url and web url for the current worktree.

**Logging in inside a worktree.** You do not log in again — you reuse the session you already have.
Cookies are not scoped by port, so the `session` cookie set at `localhost:8000` is sent to
`localhost:8252` too, and every worktree copies `.env` so `JWT_SECRET` matches. The only thing that
used to break was the lookup in `requireAuth`: the JWT carries your user's uuid as `sub`, and the
worktree's fresh database had no such row.

`.seed/identity.json` fixes that. It is a snapshot of this machine's users, orgs and memberships,
written by `bun run seed:capture` (and by `bun run setup`, once you have signed in). `bun run seed`
restores it **keeping the same uuid** and grants the restored users admin on the demo project. A
generated uuid would not do — it would authenticate as nobody.

The file is gitignored: it holds real uuids and emails, and a uuid is only meaningful on the machine
that generated it. `.worktreeinclude` lists `.seed/`, so worktrunk copies it into every new worktree
alongside `.env` — which is why the seed needs no source database, no environment variable and no
knowledge of the main checkout.

JSON rather than SQL on purpose: it stores TypeScript property names (`githubId`), and Drizzle turns
those into whatever the branch's schema currently calls that column. A `.sql` dump bakes in
`github_id` and breaks on the first branch that renames it — which is precisely the situation
worktrees create.

If a restore warns that the id was not preserved, the target database already held that GitHub id
under a different uuid.

What still does not work in a worktree is the GitHub round trip itself: clicking "Sign in" sends
`redirect_uri=http://localhost:PORT/...` and a GitHub OAuth app matches host *and port* exactly
against its one registered callback (`http://localhost:3000`). So sign in on the main checkout at
`http://localhost:8000`, then open the worktree — you are already in.

## Database

One Postgres container (`docker compose -p samskara up -d`) on port 5433, many databases inside it.
Main checkout uses `samskara`; a worktree uses `samskara_BRANCH_SLUG`.

No Docker on the machine? `scripts/local-pg.sh start` runs a dedicated local PostgreSQL cluster
on the same port 5433 with the same role, database and `DATABASE_URL`, using the Homebrew
PostgreSQL binaries. Only one of the two can own port 5433 at a time — stop the other before
switching (`scripts/local-pg.sh stop` / `bun run stack:down`). The schema needs no extensions
today, so plain PostgreSQL is enough; `recreate` drops and rebuilds the cluster from migrations.

- `bun run db:generate` — generate a migration from `packages/server/src/db/schema.ts`
- `bun run db:migrate` — the only way to bring a database up to date: drizzle-kit's migrations, then every step in `packages/server/src/db/steps.ts`, against whatever `DATABASE_URL` the local `.env` names
- `bun run db:verify` — read-only check that every step is already converged
- `bun run seed` — idempotent dev fixture: dev user, org, project, 3 sessions, then restores `.seed/identity.json` if it is there. `--from FILE` reads a different snapshot; `--if-empty` makes it a no-op when the database already has projects, which is how `setup` stays safe to re-run
- `bun run seed:capture` — write `.seed/identity.json` from the current database. `--to FILE` writes elsewhere. Writes nothing when no real user has signed in yet
- `bun run seed:org ORG_SLUG` — register a real GitHub org

**Post-migrate steps.** Some database work cannot live in a migration: `create index
concurrently` is rejected inside a migration's transaction, so the full-text search indexes are
built outside the migration journal. `db:migrate` runs drizzle-kit and then every step registered
in `MIGRATION_STEPS` (`packages/server/src/db/steps.ts`), under one advisory lock. Never migrate a
database any other way — a setup path that runs only `drizzle-kit migrate` yields a schema-correct
database with no search indexes, and search then scans and re-tokenizes all of `messages` on every
query, which looks like a hang rather than a missing step.

A step is a module beside `steps.ts` exporting `{ name, run, verify }`. `run` converges and must be
idempotent, because it runs on every migrate including ones with no new migrations; `verify` only
reads, and backs `db:verify`.

`drizzle.config.ts` has no default `DATABASE_URL`. If it is unset the migration fails loudly rather
than quietly migrating the main checkout's database.

**Column naming.** Every table and column name is camelCase. A Biome plugin
(`packages/server/src/db/naming.grit`) enforces it against `packages/server/src/db/schema.ts`, so
`bun run lint` fails on a snake_case name. The plugin reads TypeScript, not SQL, so a hand-written
migration that adds a column without touching `schema.ts` is not checked — keep `schema.ts` the
source of truth and generate migrations from it.

The server's test suite starts a real `pgvector/pgvector:pg16` container via testcontainers and runs
the migrations against it. Those tests skip themselves when Docker is not available.

## Logging

Every package logs NDJSON through `createLogger` from `@samskara/core` (pino underneath). Level
comes from `LOG_LEVEL`, defaulting to `info` in production and `debug` elsewhere. `token`,
`authorization`, `password` and `secret` are redacted from every line. Each API request gets a
`reqId` that is echoed back on the response.

## Hot reloads kill running reviews — check first

`tsx watch` restarts the server whenever `packages/server/src/**` (or a rebuilt dependency's
dist) changes, and the AI-review job registry is in-memory: **every restart silently kills any
running review**, and `tsx watch` does not re-read `.env` on reload (env vars need a full
restart). Before editing server files, rebuilding a package, or changing `.env`, check whether
a review is in flight — `curl -s localhost:3000/api/sessions/:id/aireview` returns `"job"` while
one runs, or ask the owner. Batch your edits, and never restart mid-run when avoidable.

## Long-running operations: progress before timeout

Anything that takes more than a few seconds — a harness run, a watcher sweep, a large migration,
a long curl chain — is debugged by **watching it move**, not by waiting on a timeout. The rule:

1. **Define the observable signals up front, before the run.** For an LLM-backed pipeline:
   - `export_written` (with byte count, workspace path)
   - `harness_spawning` / `harness_spawned` (with the command line + sandbox id)
   - `harness_first_byte` (the ms from spawn to the first stdout byte — the single best
     "is it alive?" signal)
   - `xml_parsed` / `grounded` / `persisted` (each at a phase boundary)
   Each milestone logs `{ milestone, elapsedMs, sessionId }` via `createLogger` so the server
   log is grep-able, and is also exposed through any "current state" API so a CLI client can
   render progress without tailing the log.

2. **The CLI surfaces the latest milestone on a cadence (15–30 s is usually right).** A
   watching human should be able to read "still working (job abc…, harness_first_byte 4 s
   ago, 62 s total)" and tell from that one line whether the run is healthy, stuck, or
   mid-failure. Never let a long op look frozen.

3. **Smoke-test on the smallest input first.** A 5-message session, a 1-record artifact, a
   one-row migration — the fastest thing that still exercises every layer. Scale up only
   after the small one passes cleanly; otherwise the long op doubles as your only signal.

4. **Log the names of the things a watcher would want to tail.** Workspace path, sandbox id,
   log file path inside the sandbox. Anyone debugging should be able to `ls`, `msb logs`, or
   `tail -f` without rummaging through the server source.

5. **Timeout messages name the last milestone.** When the wall clock trips, the message
   includes the latest server event so the next person knows where the run got stuck, not
   just that it stopped.

### Watching a live AI-review run

Pipeline milestones cover the server-side view; what the reviewer agent itself is doing
inside the msb VM lives in the sandbox's `exec.log` (one JSON line per stderr/stdout event,
the agent's bash prompts appear as `"d":"\u001b[0m$ \u001b[0m<cmd>"`). The repo ships a
companion tool for that — the AI-review watcher — that reads both streams in parallel,
counts repetitions, and flags stuck / thrashing patterns in real time:

```sh
# in one terminal: kick off the review
SAMSKARA_API_URL=http://localhost:3000 \
  bun packages/cli/src/index.ts review <session-id> --ai --timeout 540000

# in another terminal: watch it
scripts/ai-review-watch.sh                # tail milestones + flag stuck (default 90 s)
scripts/ai-review-watch.sh -t 30          # tighter stuck threshold for small sessions
scripts/ai-review-watch.sh --peek 30      # one-shot: dump the agent's last 30 bash calls
```

The watcher prints each milestone (`milestone harness_first_byte`), each new bash command
the agent runs (with a `REPEAT(n)` tag once n > 3 and a `THRASHING` warning past 5), and an
explicit `STUCK` line if `harness_spawning` is the last milestone for longer than the
threshold — at which point it tells you to `peek`. Run it any time you would have written a
`sleep 30; grep ...` loop in the shell.

## Releases

Every package carries the same version. Never hand-edit a `version` field:
`bun run release:version patch|minor|major|1.4.0` writes all five and tags the commit, and pushing
that tag is what releases. The README's "Releases" section has the rest, including why the CLI
tarball bundles core the way it does.

`scripts/` is tested by `bun test`, not vitest. Run it with `bun run test:scripts` — a bare
`bun test scripts/` also matches `packages/server/src/scripts/*.test.ts` and starts real Postgres
containers.
