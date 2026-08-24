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

`seed:dev` fixes that: during `wt:setup` it copies every user out of the main checkout's database
**keeping the same uuid**, along with their org memberships and an admin grant on the demo project.
A generated uuid would not do — it would authenticate as nobody. Set `SEED_USERS` to a
comma-separated list to narrow which users get copied; unset means all of them. If a copy warns
that the id was not preserved, the target database already held that GitHub id under a different
uuid.

What still does not work in a worktree is the GitHub round trip itself: clicking "Sign in" sends
`redirect_uri=http://localhost:PORT/...` and a GitHub OAuth app matches host *and port* exactly
against its one registered callback (`http://localhost:3000`). So sign in on the main checkout at
`http://localhost:8000`, then open the worktree — you are already in.

## Database

One Postgres container (`docker compose -p samskara up -d`) on port 5433, many databases inside it.
Main checkout uses `samskara`; a worktree uses `samskara_BRANCH_SLUG`.

- `bun run db:generate` — generate a migration from `packages/server/src/db/schema.ts`
- `bun run db:migrate` — apply migrations to whatever `DATABASE_URL` the local `.env` names
- `bun run seed:dev` — idempotent dev fixture: dev user, org, project, 3 sessions, plus the real users copied out of the main checkout's database. `--if-empty` makes it a no-op when the database already has projects, which is how `setup` stays safe to re-run
- `bun run seed:user GITHUB_LOGIN` — escape hatch: copy one named user and pin `SEED_USERS` to them. Not needed normally, since `seed:dev` copies every local user by default
- `bun run seed:org ORG_SLUG` — register a real GitHub org

`drizzle.config.ts` has no default `DATABASE_URL`. If it is unset the migration fails loudly rather
than quietly migrating the main checkout's database.
