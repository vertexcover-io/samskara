# Design: First-Class Projects + Session/Repo Decoupling

> Introduce a simple first-class `projects` entity (name + slug + owner), bind each session to
> exactly one project (resolved once from its starting directory), share projects via explicit
> per-user grants, and move the per-line git facts (`gitBranch`/`gitCommit`) down to the message
> level. Evolves the schema and the ingest contract shipped by `watch-daemon-ingest`. Removes the
> repo-centric access tables; leaves `repos` itself untouched.

## Problem

Today `sessions.repoId` is a **NOT NULL** FK to `repos` — one repo per session, resolved once
from cwd. Verified against real Claude session JSONL: a session's context **varies within the
session** — its `cwd` moves (a 380-line session showed 5 real cwd changes across a main checkout,
a git worktree of it, and a subdirectory), and its git branch/commit change too (one real session
spanned branches `main` and `fix-sessions-ux-issues`). Pinning a session to one repo — and
stamping one `gitBranch`/`gitCommit` on the whole session — mis-attributes any such session, and
forces a repo row to exist even for a workspace that has no repo at all.

A session really belongs to the **workspace it was launched in** — a _project_ — not to a repo. A
project here is deliberately minimal: a **name**, a **slug**, and an **owning user**. Two
different users working in the same repo each get their **own** project row (same slug, different
owner) — isolation by default; sharing is explicit via grants.

## Non-Goals (deferred)

- **`repos` table and per-message repo attribution.** `repos` is **not touched** by this change —
  it stays exactly as currently committed (`ownerType`, `repoName`, everything). We do **not** add
  `messages.repoId`. Per-message repo attribution and repo-creation-on-message are **fully
  deferred** to a later milestone.
- **Grant management UX/API.** How grants get created (a share UI/API) is deferred; only the data
  model + the owner-or-grant read rule land now.
- **Scope enforcement beyond read/write.** `scope` stores 3 ordered values
  (`viewer < editor < admin`) to future-proof, but only read-vs-write matters today (editor =
  read/write, viewer = read).
- **Backfill of production data** — there is none yet (schema was just committed), so migration is
  drop-and-add.

## Naming convention (load-bearing — inherited)

**camelCase everywhere** — TS, wire, config, Drizzle JS properties, **AND Postgres column names**
(`text("projectId")`, `text("ownerId")`, `text("gitBranch")`; drizzle-kit emits quoted
identifiers so the casing survives Postgres lowercase-folding). New tables added here follow the
same rule as `sessions`/`messages`: quoted camelCase columns, no snake_case seam. Any hand-written
migration SQL must double-quote column names.

## What a project is (decided)

A session is created in some starting directory. Its _project_ is derived **once** from that
starting directory and never changes for the life of the session. A project is just three facts:

- **name** — the git repo name if the starting dir is a git repo; else the cwd basename.
- **slug** — a stable, unique-per-owner identifier derived from the dir (see resolution rules).
- **ownerId** — the user who created it (the running user).

There is **no `type`, no `namespace`, no nullable ownership, no NULLS-NOT-DISTINCT, no CHECK**.
Projects are personal by construction: `UNIQUE (slug, ownerId)` means _my_ project in a given repo
and _your_ project in the same repo are two distinct rows. Sharing is explicit and additive
(`userProjectGrant`), never implicit.

## Key Decisions

| #   | Decision                                                                                                                                                  | Rationale                                                                                                                              |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | New first-class **`projects`** table = `name` + `slug` + `ownerId` only                                                                                   | A session belongs to a workspace, not a repo; keep the entity minimal — no type/namespace machinery.                                   |
| P2  | **`ownerId` NOT NULL FK to users**; `UNIQUE (slug, ownerId)`                                                                                              | Projects are personal by default: same repo, two users → two rows. Isolation by default; sharing is opt-in.                            |
| P3  | **Sharing via `userProjectGrant(userId, projectId, scope)`**, PK `(userId, projectId)`                                                                    | Explicit additive access. Owner is admin by derivation from `projects.ownerId` (never has a grant row); grants only elevate OTHER users. |
| P4  | **`scope ∈ {admin, editor, viewer}`**, STRICTLY ORDERED `viewer < editor < admin`; checks are `scope >= required`, not exact-match                        | A higher tier implies the lower (editor can view; admin can edit + view). Only read/write enforced today; ordering future-proofs it.    |
| P5  | **`session → project` is 1:1**; `sessions.projectId` (NOT NULL) **replaces** `sessions.repoId` (drop `repoId`)                                            | Resolved once at session creation from the starting dir; the session's identity is its project.                                        |
| P6  | **Move `gitBranch`/`gitCommit` from `sessions` to `messages`** (both nullable on messages)                                                                | Verified they vary per line within a session; they describe _where a line happened_, not the session.                                  |
| P7  | **DROP `userRepos` and `orgRepos`** (schema.ts + migration + repo modules + ingest grant/link step)                                                       | The repo-centric access model is replaced by owner-or-grant (P3). Keep `userOrgs`, `orgs`, `users`.                                    |
| P8  | **`repos` + `messages.repoId` are UNTOUCHED / deferred**                                                                                                  | Per-message repo attribution is a later milestone; `repos` stays exactly as committed and is not read or written by this change.       |
| P9  | **Authorization = owner-or-grant** (resolved, not deferred): admin iff `ownerId = you` OR an `admin` grant; editor/viewer via scope order; visible iff `ownerId = you` OR any grant; sessions inherit project visibility | Simple, self-contained; owner is admin by derivation (no grant row); `admin` grants elevate others without moving ownership. No GitHub-API / repo-membership derivation. |

## Schema

TIMESTAMPTZ; TEXT+CHECK over pg enums; camelCase quoted columns (matches existing convention).

```
projects
  id          uuid PK
  name        text NOT NULL      -- git repo name if the dir is a git repo; else cwd basename
  slug        text NOT NULL      -- stable identifier derived from the dir (see resolution)
  ownerId     uuid NOT NULL → users(id) ON DELETE CASCADE   -- the user who created it
  createdAt, updatedAt
  UNIQUE ("slug","ownerId")

userProjectGrant
  userId      uuid NOT NULL → users(id)    ON DELETE CASCADE
  projectId   uuid NOT NULL → projects(id) ON DELETE CASCADE
  scope       text NOT NULL CHECK ("scope" in ('admin','editor','viewer'))   -- ordered: viewer<editor<admin
  createdAt
  PRIMARY KEY ("userId","projectId")
  -- owner (projects.ownerId) is admin BY DERIVATION and has NO grant row.
  -- grants hold only EXPLICITLY-SHARED access, granted to OTHER users.
```

Changes to existing tables:

```
sessions
  - DROP  repoId                                   -- (was uuid NOT NULL → repos)
  - DROP  gitBranch                                -- moves to messages (P6)
  - DROP  gitCommit                                -- moves to messages (P6)
  + ADD   projectId  uuid NOT NULL → projects(id) ON DELETE CASCADE     -- P5
  (KEEP cwd (launch context), model, title, cliVersion, permissionMode, source, userId)
  INDEX(projectId)

messages
  + ADD   gitBranch  text NULLABLE                 -- derived from the line's own JSONL fields
  + ADD   gitCommit  text NULLABLE
  (NO repoId — deferred, P8)
```

`repos`, `orgs`, `userOrgs`, `users` are **unchanged**. `userRepos` and `orgRepos` are **DROPPED**
(P7).

## Slug + name derivation (`resolveProject`, client-side, from the starting dir)

`resolveProject(startDir) → { name, slug }`, run once when the main session is first created:

1. **git repo WITH a github remote** — `git config --get remote.origin.url` parses to
   `owner/reponame`:
   - `name = reponame`
   - `slug = "<owner>-<reponame>"` (i.e. `"<owner>/<reponame>"` with `/` → `-`).
2. **not a git repo, or no remote** —
   - `name = basename(cwd)`
   - `slug =` cwd with **all path separators replaced by `-`** — blanket-replace **both `/` and
     `\`** (cross-platform: Windows + Linux). A leading separator just becomes a leading `-`; no
     special-casing of the leading char or a Windows drive colon. It is a slug — uniqueness
     matters, not prettiness.

Then the server upserts `projects` **ON CONFLICT (slug, ownerId) DO NOTHING/UPDATE** (ownerId =
the JWT user) and sets `session.projectId`.

This **replaces/extends** the existing `resolveRepo` in
`packages/cli/src/watcher/resolveRepo.ts`: the same git-remote-else-local branch, but emitting
`{ name, slug }` instead of a `RepoIdentity`.

## Authorization (resolved)

Scopes are **strictly ordered**: `viewer < editor < admin`. A higher tier implies the lower ones
(editor can view; admin can edit + view). All checks are **`scope >= required`**, never
exact-match. Authority is derived as:

- **admin** — iff `projects.ownerId = the user` **OR** a grant row `(userId, projectId, 'admin')`
  exists.
- **editor** (read/write) — iff admin, **OR** a grant row with scope `editor`.
- **viewer** (read) — iff any of the above, **OR** a grant row with scope `viewer`.
- **visible at all** — iff `projects.ownerId = the user` **OR** any grant row exists.

**Sessions inherit project visibility** — you can see a session iff you can see its project.

The **owner** (`projects.ownerId`) is admin **by derivation** and has **no grant row** — we do
**not** insert an owner/admin grant on project creation. `userProjectGrant` rows hold only
explicitly-shared access, granted to **OTHER** users. So the distinction is: `ownerId` is the
identity / resolution / idempotency key (`UNIQUE (slug, ownerId)`) and the implicit top authority
— the owner never changes and never has a row; `admin` grants exist to **elevate other users to
top authority without moving ownership**. A multi-admin project = owner + admin-granted users.

This **replaces** the old repo/org-membership/namespace visibility idea entirely: no GitHub-API
checks, no repo-based access, no derivation off `userOrgs`/`orgs`. Simple owner-or-grant.

## Ingest contract revision (supersedes the frozen `repo`-at-envelope decision)

The `watch-daemon-ingest` "Ingest contract (frozen)" puts `repo {host,owner,ownerType,repoName}`
at the **flush envelope** level and `gitBranch`/`gitCommit` inside the envelope `session{}` block.
**This design supersedes both.**

- The envelope carries **`project { name, slug }`** (replacing envelope-level `repo`). The server
  resolves `ownerId` itself from the **JWT user** (never sent by the client), upserts `projects`
  **ON CONFLICT (slug, ownerId)**, and sets `sessions.projectId`.
- **`gitBranch`/`gitCommit` move OUT of the envelope `session{}` block and become per-message
  fields** (both optional), derived from each line's own JSONL git fields.

High-level shape (camelCase on the wire, optional fields omitted):

```ts
interface ProjectIdentity {
  name: string; // git repo name, or cwd basename
  slug: string; // "<owner>-<reponame>", or cwd with separators → "-"
  // NOTE: no ownerId — server derives it from the JWT user
}

// main flush envelope (was: repo + session.gitBranch/gitCommit at top level)
interface IngestMainEnvelope {
  sessionId: string;
  type: "main";
  sourceRelativePath: string;
  project: ProjectIdentity; // REPLACES envelope-level `repo`
  session: SessionFields; // model, title, cwd, cliVersion, permissionMode
  //   (NO gitBranch/gitCommit — now per-message)
  rawLines: RawLine[];
  messages: Array<
    NormalizedMessage & {
      gitBranch?: string; // per-message (P6), derived from the line
      gitCommit?: string;
    }
  >;
}
```

Server changes implied (one txn, extending the existing sequence):

1. resolve `userId` from JWT (unchanged).
2. **resolve/upsert `projects`** from `project` + `ownerId = userId`; `type==='main'` upserts
   `sessions` with the resolved `projectId` (replacing the old repo upsert → `sessions.repoId`
   step). The old **`userRepos` grant + `orgRepos` link** step is **removed** (P7).
3. insert `messages` (dedupe on `(lineUuid,subIndex)`), now also storing each message's
   `gitBranch`/`gitCommit`. Tool-table derivation, tokens, and `parentAgentId` unchanged.

## Migration

This evolves the schema **just committed**. There is **no production data**, so a drop-and-add is
acceptable — mirror how the prior `0002` migration drop-and-recreated rather than a
data-preserving alter. One migration:

1. **CREATE `projects`**, **CREATE `userProjectGrant`** (with its `scope` CHECK and PK).
2. **ALTER `sessions`**: `ADD projectId uuid NOT NULL → projects` (safe: table is empty),
   `DROP COLUMN repoId`, `DROP COLUMN gitBranch`, `DROP COLUMN gitCommit`.
3. **ALTER `messages`**: `ADD gitBranch text NULL`, `ADD gitCommit text NULL`.
4. **DROP TABLE `userRepos`, `orgRepos`** — remove both from `schema.ts`, delete their repository
   modules and the `services/ingest.ts` grant/link step, and drop their references in
   `ingest.test.ts`.

`repos` and the rest of `messages` are otherwise **untouched**. If any dev DB holds throwaway
rows, truncate `sessions`/`messages` first (dependent tool/token/subagent rows cascade).

## Open Questions

1. **(a) drizzle-kit output.** Confirm drizzle-kit emits `UNIQUE ("slug","ownerId")` and the
   `scope` CHECK cleanly. Should be trivial; flag only if the generator needs a hand-written
   index/constraint.
2. **(b) Grant lifecycle.** How grants get created and managed — the share UI/API — is deferred;
   only the data model + the owner-or-grant read rule land now.
3. **(c) Unresolvable starting dir.** How a session's project is resolved when its starting dir
   can't be determined: the fallback slug-from-cwd (branch 2) is the answer, but note the edge —
   if even `cwd` is unknown, project resolution must still produce _some_ deterministic slug or
   reject the flush.
