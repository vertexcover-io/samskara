# samskara

Capture platform for AI coding-agent session logs (Claude Code first, generic by design).
Summarizes sessions and serves a web UI + API/MCP for search.

This repository is currently a **plumbing-only scaffold** — every package builds,
typechecks, lints, and has a passing test, but there is no product logic yet.

## Packages

| Package             | Purpose                                                        |
| ------------------- | -------------------------------------------------------------- |
| `@samskara/core`    | Canonical shared types (session, event, `SourceAdapter`). Stub. |
| `@samskara/cli`     | `samskara` binary. Stub supporting `--version`.                |
| `@samskara/server`  | Hono API on Node. Drizzle + postgres-js + pgvector. `/health`. |
| `@samskara/web`     | Vite 6 + React 18 + Tailwind v4 UI.                            |

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
```

## Server structure

```
packages/server/src/
  db/        client.ts (postgres-js + drizzle), customTypes.ts (vector),
             schema.ts (no tables yet), db.test.ts
  routes/    HTTP routes (stub)
  services/  business logic for routes (stub)
  lib/       shared utilities (stub)
  app.ts     Hono app, /health
  index.ts   Node server entry
```

## Database

Postgres 16 with the pgvector extension, exposed on host port **5433**:

```sh
bun run stack:up
```

No tables or migrations exist yet. The server package's Vitest suite spins up a real
`pgvector/pgvector:pg16` container via testcontainers, connects with the postgres-js
client, and asserts the `vector` extension loads and a vector literal round-trips. It is
skipped when Docker is unavailable.

Tables will be defined in `db/schema.ts` (embeddings via `vector()` from
`db/customTypes.ts`); drizzle-kit migrations get wired back up at that milestone.
