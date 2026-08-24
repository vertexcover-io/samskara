# Samskara

Bun + Turborepo monorepo. Packages: `core` (ingest/domain), `server` (Hono + Drizzle + Postgres),
`web` (React + Vite), `cli`. Tests are vitest; lint/format is biome. TDD — write the test first.

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
