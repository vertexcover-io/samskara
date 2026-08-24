---
name: create-worktree
description: Use when starting feature work in this repo that needs an isolated workspace, or before executing an implementation plan - creates a git worktree via worktrunk (`wt`) so the branch gets its own Postgres database, its own ports and its own real `.env`.
---

# Creating a worktree in samskara

This repo's worktrees are created by `wt` (worktrunk), not by `git worktree add`. Use this skill
instead of the harness `using-git-worktrees` skill, which symlinks `.env` and would put every
branch back on the shared `samskara` database.

**Announce at start:** "I'm using the create-worktree skill to set up an isolated workspace."

## Why it is not plain `git worktree add`

Every branch talks to one Postgres container. Sharing one database means a migration on one branch
rewrites the schema every other branch reads, and two branches cannot run the app at once. The
`.config/wt.toml` hooks fix both, but only `wt` runs them.

## Steps

### 1. Make sure the database container is up

```bash
docker compose -p samskara up -d --wait
```

The hooks create a database inside that container; they cannot start it.

### 2. Create the worktree

```bash
wt switch --create BRANCH_NAME
```

Branch names follow the repo convention: `feat/…`, `fix/…`, `chore/…`.

On first run `wt` asks to approve the project's hook commands. If the session cannot answer an
interactive prompt, use `wt switch --create BRANCH_NAME --yes`.

This runs, in order: `wt step copy-ignored` (real `.env`, not a symlink) → `bun install` →
`bun run wt:setup`, which rewrites the worktree's `.env`, creates `samskara_BRANCH_SLUG`, migrates
it and seeds dev data.

### 3. Confirm the isolation actually happened

`wt:setup` prints this worktree's db, api and web urls as it finishes. `DATABASE_URL` must end in
`samskara_SLUG`, never plain `/samskara`. To re-check later, from the worktree root:

```bash
test -L .env && echo "BROKEN: .env is a symlink, so every branch shares one database"
grep -E '^(DATABASE_URL|PORT|WEB_PORT)=' .env
```

If `.env` is a symlink or `DATABASE_URL` is still plain `samskara`, run `bun run wt:setup` and
re-check — do not start work until it is isolated.

### 4. Check you can still log in

`wt:setup` copies this machine's GitHub users into the new database with their uuids intact, so the
session cookie the developer already holds works here. Nothing to do — but if `/api/auth/me` comes
back 401, re-run `bun run wt:setup`.

Signing in from inside the worktree will not work: a GitHub OAuth app matches host and port exactly
against its single registered callback on port 3000. Sign in on the main checkout instead — cookies
ignore ports, so the session carries over.

### 5. Verify a clean baseline

```bash
bun run typecheck && bun run test
```

If tests fail, report the failures and ask whether to proceed — a dirty baseline makes new
breakage indistinguishable from pre-existing breakage.

### 6. Report

Give the worktree path, the branch, the db/api/web urls `wt:setup` printed, and the test result.

## Cleanup

```bash
wt remove
```

The `pre-remove` hook drops that worktree's database. Removing the directory by hand leaks it;
`bun run wt:teardown` from inside the worktree drops it on its own.
