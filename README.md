# samskara

Capture platform for AI coding-agent session logs (Claude Code first, generic by design).
Summarizes sessions and serves a web UI + API/MCP for search.

The identity mesh (users/orgs/repos/sessions), the **auth system** (GitHub OAuth web
login, org-allowlist gate, session/CLI JWTs, browserless CLI pairing), and the **application
UI** (projects, filtered sessions index, session detail viewer, CLI pairing and logout) are in
place. Every package builds, typechecks, lints, and passes its tests.

## Packages

| Package             | Purpose                                                        |
| ------------------- | -------------------------------------------------------------- |
| `@samskara/core`    | Shared types, the collector framework (`SourceAdapter` + Claude plugin), ingest types, and the `createLogger` logging factory. |
| `@samskara/cli`     | `samskara` binary. Pairing, per-folder capture opt-in, status, and a hook-revived background watcher. |
| `@samskara/server`  | Hono API on Node. Drizzle + postgres-js + pgvector. Auth + `/health` + `/api/ingest`. |
| `@samskara/web`     | Vite 6 + React 18 + Tailwind v4 UI. React Router routes, auth guard, projects, sessions index, and the session detail viewer. |

## Requirements

- [Bun](https://bun.sh) 1.2.19+
- Docker (for the Postgres/pgvector container and the server DB test)
- Node 22+

## Setup

```sh
bun install
cp .env.example .env
```

## Commands

```sh
bun run dev         # turbo run dev across packages
bun run build       # build all packages
bun run typecheck   # typecheck all packages, plus the e2e project
bun run lint        # biome check .
bun run test        # run all package tests
bun run e2e         # Playwright end-to-end suite (boots server + web, seeds the DB)
bun run e2e:ui      # the same suite in Playwright's UI mode
bun run format      # biome format --write .

bun run stack:up    # docker compose up -d (Postgres/pgvector on :5433)
bun run stack:down  # docker compose down
bun run db:migrate  # apply drizzle migrations
bun run seed:org <github-slug>   # seed an allowed org (login is gated to members)
```

## Auth

GitHub OAuth web login, gated to members of a seeded org. Config lives in `.env` (see
`.env.example`): `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET`, `JWT_SECRET`, `PUBLIC_BASE_URL`,
`WEB_BASE_URL` (default `http://localhost:8000`), `COOKIE_SECURE`, `JWT_EXPIRES_IN` (default `7d`).
Ports: backend `:3000`, web `:8000`
(Vite proxies `/api` → `:3000`).

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET  | `/api/auth/github/start`    | none     | Set `oauth_state` cookie, redirect to GitHub |
| GET  | `/api/auth/github/callback` | none     | Verify state, exchange code, org-gate, upsert user, set session |
| GET  | `/api/auth/me`              | web      | Current user |
| POST | `/api/auth/logout`          | web      | Clear session cookie |
| POST | `/api/auth/cli-code`        | web      | Mint a CLI pairing code |
| POST | `/api/auth/cli-exchange`    | none     | Redeem a code → `aud:cli` JWT |
| GET  | `/api/projects`             | web      | Projects the user can read, with session counts and last activity |
| GET  | `/api/sessions`             | web      | Readable sessions, newest first; optional `project`, `user`, `range` filters |
| GET  | `/api/sessions/:id`         | web      | One session with its messages, tool calls, subagents, and token usage |
| POST | `/api/ingest`               | cli      | Flush a captured session (messages, tool calls, subagents) |

Tokens are audience-scoped (`aud: web | cli`) and checked per route by `requireAuth(aud)`.
`samskara login` pairs the CLI: it redeems a code for an `aud:cli` token stored at
`~/.samskara/token` (`0600`).

## CLI capture lifecycle

```sh
samskara init                 # login if needed, install hook, start watcher
samskara enable [path]        # enable one folder (cwd by default)
samskara disable [path]       # stop capturing it locally; cloud data is retained
samskara status               # projects, last-sync timestamps, watcher PID/log
samskara logout               # stop watcher and remove the CLI token
```

Capture is local-only and opt-in. Enabled folders live in `~/.samskara/projects.json`; each entry is
keyed by project slug and stores `{ name, path, enabled, enabledAt }`. Git remotes provide stable
project identities when available, while non-git folders use a path-derived identity. Override all
local state paths with `SAMSKARA_HOME`.

`init` installs a managed Claude Code `SessionStart` hook. The hook runs the hidden `ensure` command,
which revives the detached singleton watcher and tells the agent when authentication or project
enablement is missing. Watcher output is appended to `~/.samskara/watch.log`; its PID is stored in
`~/.samskara/watch.pid` (`0600`). `install-hooks` and `uninstall-hooks` manage the hook explicitly.
The foreground `samskara watch` command remains available for debugging. It polls Claude Code session
files, resolves the owning project, captures only enabled project slugs, and POSTs flushes to
`/api/ingest`. Explicit `watch --project-name ... --project-slug ...` overrides bypass the registry.

## Logging

Every package logs structured NDJSON via `createLogger(base, opts?)` from `@samskara/core`
(pino under the hood — no pretty transport, ever). `base` must include `service`
(`samskara-server`, `samskara-cli`), and `createLogger` redacts `token`, `authorization`,
`*.token`, `req.headers.authorization`, `password`, and `secret` from every line.

- **Level:** `LOG_LEVEL` env var (`fatal`|`error`|`warn`|`info`|`debug`|`trace`) if set and
  valid; otherwise `info` when `NODE_ENV=production`, `debug` otherwise. An invalid `LOG_LEVEL`
  falls back to the same default and warns once (never throws).
- **CLI:** `samskara --verbose <command>` forces `debug` regardless of env/`NODE_ENV`.
- **Server:** a global Hono middleware (`lib/logging-middleware.ts`) mints a `reqId` (trusts an
  incoming `x-request-id` header if non-blank, else `randomUUID()`), echoes it on the response,
  and binds a per-request child logger to `c.set("log", …)` carrying `{reqId, method, path}`.
  `requireAuth` enriches it with `userId`; the ingest handler enriches it with
  `{sessionId, eventCount, repo, isSubagent}` via `setBindings` (same instance, not re-childed).
  One `info` completion line `{status, ms}` is logged per request; `onError` logs at `error`
  through `c.get("log")` when present, else the server root logger, and always returns
  `{error: "internal"}` with status 500.

## Server structure

```
packages/server/src/
  db/            client.ts (postgres-js + drizzle), customTypes.ts (vector), schema.ts
  repositories/  drizzle queries per model (users/orgs/projects/sessions)
  routes/        auth.ts (OAuth + session + CLI pairing), ingest.ts (session flush),
                 projects.ts + sessions.ts (read-only web API behind requireAuth("web"))
  services/      github.ts (GithubClient seam), auth.ts (gate + upsert), pairing.ts, ingest.ts
  lib/           env.ts (zod config), jwt.ts (jose), cookies.ts, require-auth.ts,
                 logging-middleware.ts (reqId + request child logger)
  scripts/       seed-org.ts
  app.ts         buildApp(db, env, deps) — Hono app, /health + /api/auth + /api/ingest
                 + /api/projects + /api/sessions
  index.ts       Node server entry — logs "server listening" via the root logger
```

## Search

Sessions are searchable by what was said inside them, including tool output. A turn becomes a
`sessionChunk` row at ingest; the in-flight turn of a live session is deliberately skipped, because
its text would still be changing under an already-computed embedding.

Ranking fuses three lists — keyword, semantic, and session title — with Reciprocal Rank Fusion.
The keyword half works immediately. The semantic half needs an embedding provider; with none
configured, search silently degrades to keyword-only, which is the default state of a fresh
deployment.

The provider is an HTTP contract rather than a dependency: anything speaking the OpenAI-shaped
`POST /v1/embeddings` works by changing configuration alone. The shipped default is a **local**
model, so no paid credential is needed:

```sh
ollama serve && ollama pull mxbai-embed-large
```

then, in `.env`:

```sh
EMBEDDING_BASE_URL=http://localhost:11434/v1
EMBEDDING_API_KEY=ollama
EMBEDDING_MODEL=mxbai-embed-large
EMBEDDING_QUERY_PREFIX=Represent this sentence for searching relevant passages:
```

`EMBEDDING_QUERY_PREFIX` exists because open models express the query/document asymmetry as an
instruction prefix, where Voyage expresses it as an `input_type` field; the client sends both and
each provider ignores the one it does not understand. Omit the prefix for Voyage or OpenAI.

Two caveats worth knowing before pointing this at a hosted provider:

- **`VECTOR_MAX_DISTANCE` is model-specific.** It is the ceiling past which a chunk is not a match,
  and it was measured against `mxbai-embed-large`: genuine matches sit at 0.14–0.31 and unrelated
  text at 0.53–0.69, so the ceiling sits in the gap. A different model packs unrelated text
  differently — re-measure by embedding a query that should match nothing and putting the ceiling
  below the closest thing it returns.
- **Chunk text leaves the machine.** The worker POSTs each chunk's embed text to the configured
  provider, and that text includes tool names and their inputs. There is no per-project opt-out
  yet, so with a hosted provider every captured session's content egresses.

## Web UI

React Router routes, all but `/login` behind `RequireAuth` (which renders a loading shell while
`/api/auth/me` resolves, so protected data never flashes before the check settles):

| Route | Screen |
|---|---|
| `/login` | GitHub sign-in; redirects to `/projects` when already authenticated |
| `/projects` | Project cards — name, slug, session count, last activity, last session title |
| `/sessions` | Session index. Project, User, and Date Range filters read from and write to the query string, so any filtered view is a shareable link and Back/Forward restore it |
| `/sessions/:sessionId` | Session detail — Conversation, Timeline, Tool Calls, and Artifacts tabs, plus expandable subagent branches |

Unmatched paths redirect to `/projects`. The app shell carries an account menu with CLI pairing and
logout.

```
packages/web/src/
  api/        typed fetch adapters (client.ts, parse.ts, types.ts, account.ts)
  auth/       AuthProvider.tsx, RequireAuth.tsx, SessionExpired.tsx
  routes/     Login.tsx, Projects.tsx, Sessions.tsx, SessionDetail.tsx
  shell/      AppShell.tsx, AccountMenu.tsx, LoadingShell.tsx
  session/    detail viewer — Tabs, RecordStream, ToolCallsView, ArtifactsView, SubagentAnnex
  components/ ProjectCard.tsx, SessionRow.tsx, FilterBar.tsx
  sessions/   filters.ts (query-string ⇄ filter state)
  index.css   Tailwind v4 tokens in an @theme block (no tailwind.config file)
```

End-to-end tests live in `e2e/` and run against a real browser. `e2e/playwright.config.ts` boots
both the API server and Vite and seeds Postgres; `e2e/fixtures/auth.ts` mints an HS256 session
cookie directly, so the suite authenticates without a GitHub round trip.

## Database

Postgres 16 with the pgvector extension, exposed on host port **5433**:

```sh
bun run stack:up
```

The identity mesh (`users`, `orgs`, `repos`, `user_orgs`, `projects`, `user_project_grant`,
`sessions`, `messages`, `tool_call`, `tool_result`, `subagents`, `token_usage`) is defined in
`db/schema.ts` with drizzle-kit migrations under `packages/server/migrations/`. Apply them with
`bun run db:migrate`. The auth system adds no new tables (pairing codes are in-memory).

Search adds `sessionChunk`: one row per closed turn per track, carrying two text projections and a
`vector(1024)` embedding. Two things in its migration are hand-written and will not survive a
regeneration by `db:generate` alone — `CREATE EXTENSION vector` and the GIN index over
`to_tsvector('english', "searchText")`. drizzle-kit emits neither, so if you regenerate the
migration, add both back.

The server package's Vitest suite spins up a real `pgvector/pgvector:pg16` container via
testcontainers and runs the migrations against it, so the schema and the auth routes are
tested end-to-end. It is skipped when Docker is unavailable.
