---
name: prod-db
description: Use when a question is about the deployed samskara server rather than local code - which version is live, what pm2 says, or anything that needs a SQL query against the production database. Runs read-only by default and requires explicit confirmation before any write.
---

# Querying the deployed server

The production server has no local checkout and no shared PATH: `bun`, `node`, `pm2` and the
`.env` holding `DATABASE_URL` all live inside the app user's home. `prod.sh` handles that — it
ssh's in as a login user, escalates to the app user with passwordless `sudo -u`, sources
`DATABASE_URL` from the server's own `.env`, and pipes the query to `psql` over stdin.

The connection string never appears on a command line and never leaves the server. Never try to
read `.env` or echo `DATABASE_URL` to work around this.

**Announce at start:** "I'm using the prod-db skill to query the deployed server."

## Required arguments

`-u SSH_USER` and `-H HOST` are always required — there is no default and no `~/.ssh/config`
lookup, so the target is always visible in the command. If the user has not said which login to
use, ask; do not guess.

| Command | What it does |
|---|---|
| `.claude/skills/prod-db/prod.sh -u USER -H HOST version` | Deployed package version and pm2 status |
| `.claude/skills/prod-db/prod.sh -u USER -H HOST sql 'QUERY'` | Runs inside `begin; set transaction read only;` |
| `.claude/skills/prod-db/prod.sh -u USER -H HOST sql -f FILE` | Same, query read from a local file |
| `.claude/skills/prod-db/prod.sh -u USER -H HOST sql --write 'QUERY'` | Normal transaction; rolls back entirely on error |

Override the server side with `--app-user USER` and `--dir PATH` when the deployment is not the
default `refrensaitracker` layout.

## Reads

Just run them. Read-only mode is enforced by Postgres, not by inspecting the query text, so a
write that slipped past a text check would still be rejected by the server. Use `-f FILE` for
anything long or multi-statement — a heredoc through several layers of quoting is where mistakes
hide.

Column and table names are camelCase and therefore need double quotes in SQL:
`select "githubSlug" from orgs`, `select * from "userOrgs"`. An unquoted `githubSlug` is folded to
`githubslug` and the query fails with "column does not exist".

## Writes — always confirm first

Never pass `--write` without confirming with the user first, through `AskUserQuestion`, even when
the user's own message asked for the change. What they asked for and what the SQL actually does
are different things, and the gap is the whole point of the check.

The confirmation must show four things:

1. **The exact SQL** that will run, verbatim — not a paraphrase.
2. **One or two sentences** on what it changes, in plain language.
3. **How many rows it will touch.** Run the matching `select count(*)` as a read first. "Unknown"
   is not acceptable — an `update` with a typo'd `where` silently rewriting the whole table is the
   failure this exists to catch.
4. **Any consequence the user is unlikely to have thought of.** This is the part that earns the
   confirmation. Look for it before asking, and say plainly when there is none.

Things worth checking before you ask, because this schema has bitten before:

- **Check constraints that make an update fail or an owner vanish.** `projects_one_owner_check`
  requires exactly one of `ownerId` / `ownerOrgId` to be set, so setting an org owner *must* null
  the user owner in the same statement — and that user then loses their access path.
- **Access loss.** Visibility comes from `userOrgs` membership, `userProjectGrant`, or
  `users.isSuperAdmin`. Re-owning a project to an org with no members hides it from everyone
  except super admins. Check whether the affected users are super admins before saying who is
  locked out.
- **Partial unique indexes.** `projects_slug_owner_org_unique` is on `(slug, ownerOrgId)` and
  applies only where `ownerId is null`. Two rows can share a slug while user-owned and then
  collide the moment the second one moves to an org.
- **`on delete cascade`.** Most foreign keys here cascade. Deleting one org or project takes its
  projects, sessions, messages and artifacts with it. Say how many rows go, not just the one.

If the user confirms, run it and then show the state **after** the change, queried back from the
database — not the row count psql reported. For anything touching more than a handful of rows,
select the affected rows before and after and show both.

## What this skill will not do

- No `drop`, `truncate`, or schema DDL. Schema changes belong in a migration under
  `packages/server/src/db/schema.ts` and reach production through `db:migrate`, so that every
  environment gets them. A hand-applied DDL makes production diverge from every other database
  and from the migration journal.
- No writing files into the app directory to run them. `prod.sh` pipes over stdin precisely so
  nothing is left behind on the server.
