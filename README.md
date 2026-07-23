# samskara

Capture platform for AI coding-agent session logs (Claude Code first, generic by design).
Summarizes sessions and serves a web UI + API/MCP for search.

The identity mesh (users/orgs/repos/sessions) and the **auth system** (GitHub OAuth web
login, org-allowlist gate, session/CLI JWTs, browserless CLI pairing) are in place. Every
package builds, typechecks, lints, and passes its tests.

## Packages

| Package             | Purpose                                                        |
| ------------------- | -------------------------------------------------------------- |
| `@samskara/core`    | Canonical shared types (session, event, `SourceAdapter`). Stub. |
| `@samskara/cli`     | `samskara` binary. `--version`, and `login` (CLI pairing).     |
| `@samskara/server`  | Hono API on Node. Drizzle + postgres-js + pgvector. Auth + `/health`. |
| `@samskara/web`     | Vite 6 + React 18 + Tailwind v4 UI. GitHub login entry.        |

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
bun run typecheck   # typecheck all packages
bun run lint        # biome check .
bun run test        # run all package tests
bun run format      # biome format --write .

bun run stack:up    # docker compose up -d (Postgres/pgvector on :5433)
bun run stack:down  # docker compose down
bun run db:migrate  # apply drizzle migrations
bun run seed:org <github-slug>   # seed an allowed org (login is gated to members)
```

## Auth

GitHub OAuth web login, gated to members of a seeded org. Config lives in `.env` (see
`.env.example`): `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET`, `JWT_SECRET`, `PUBLIC_BASE_URL`,
`COOKIE_SECURE`, `JWT_EXPIRES_IN` (default `7d`). Ports: backend `:3000`, web `:8000`
(Vite proxies `/api` → `:3000`).

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET  | `/api/auth/github/start`    | none     | Set `oauth_state` cookie, redirect to GitHub |
| GET  | `/api/auth/github/callback` | none     | Verify state, exchange code, org-gate, upsert user, set session |
| GET  | `/api/auth/me`              | web      | Current user |
| POST | `/api/auth/logout`          | web      | Clear session cookie |
| POST | `/api/auth/cli-code`        | web      | Mint a CLI pairing code |
| POST | `/api/auth/cli-exchange`    | none     | Redeem a code → `aud:cli` JWT |

Tokens are audience-scoped (`aud: web | cli`) and checked per route by `requireAuth(aud)`.
`samskara login` pairs the CLI: it redeems a code for an `aud:cli` token stored at
`~/.samskara/token` (`0600`).

## Server structure

```
packages/server/src/
  db/            client.ts (postgres-js + drizzle), customTypes.ts (vector), schema.ts
  repositories/  drizzle queries per model (users/orgs/userOrgs)
  routes/        auth.ts (OAuth + session + CLI pairing)
  services/      github.ts (GithubClient seam), auth.ts (gate + upsert), pairing.ts
  lib/           env.ts (zod config), jwt.ts (jose), cookies.ts, require-auth.ts
  scripts/       seed-org.ts
  app.ts         buildApp(db, env, deps) — Hono app, /health + /api/auth
  index.ts       Node server entry
```

## Database

Postgres 16 with the pgvector extension, exposed on host port **5433**:

```sh
bun run stack:up
```

The identity mesh (`users`, `orgs`, `repos`, `user_orgs`, `user_repos`, `org_repos`,
`sessions`, `messages`, `subagents`, `token_usage`) is defined in `db/schema.ts` with
drizzle-kit migrations under `packages/server/migrations/`. Apply them with
`bun run db:migrate`. The auth system adds no new tables (pairing codes are in-memory).

The server package's Vitest suite spins up a real `pgvector/pgvector:pg16` container via
testcontainers and runs the migrations against it, so the schema and the auth routes are
tested end-to-end. It is skipped when Docker is unavailable.
