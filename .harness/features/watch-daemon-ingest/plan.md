# Plan: Watch Daemon + Ingest + Data Model (2b)

> Implements `.harness/features/watch-daemon-ingest/design.md`. The capture pipeline: client
> watcher (discover + parse Claude session JSONL), the frozen `/api/ingest` contract, server
> upsert + reconciliation, the sessions/messages/tool/subagents schema, and the `AgentPlugin`
> collector framework. Builds on the existing identity mesh + auth (`aud:cli` JWT). Replaces the
> outdated snake_case scaffold tables (`sessions/messages/subagents/tokenUsage`) with the design
> schema.

## Acceptance Criteria

- New capture tables use **camelCase quoted Postgres columns** (`text("sessionId")`) per the
  design; existing auth tables (`users/orgs/repos`) stay snake_case.
- `messages` uses `UNIQUE(lineUuid, subIndex)` fan-out identity; `toolCall`/`toolResult` are
  separate server-derived tables; rollup columns (messageCount/first/lastEventAt) are dropped (S1).
- `POST /api/ingest` (Bearer `aud:cli` JWT): a **main** flush upserts session + repo + grants
  userRepo (+ org link if seeded org), dedupes messages `ON CONFLICT(lineUuid,subIndex)`, derives
  tool tables, returns `{ingested, deduped}`.
- A **subagent** flush whose session is absent → `409 {error:"sessionNotFound"}`, nothing written
  (I2); the watcher leaves the watermark and retries.
- Re-ingest / replay is idempotent (dedupe + tool delete-and-replace + upsert).
- `parentAgentId` resolves deferred, session-scoped, order-independent (I4).
- Watcher: poll-glob discovery, per-file line watermark, ≤2000 lines/flush, main-before-subagent
  ordering, watermark advances **only on 2xx**, torn trailing line self-heals, restart resumes.
- Baseline stays green: identity-mesh tests, typecheck, lint.

## Auto-mode decisions (no live Q&A; recorded here)

- **D1 — Column casing:** new capture tables are **camelCase** quoted columns (design's load-bearing
  rule). Confirmed with user. Existing auth tables untouched.
- **D2 — `msgType` canonical value set:** the **10-value `MsgType` union**
  (`user|assistant|system|toolCall|toolResult|progress|systemEvent|queueOperation|fileSnapshot|summary`)
  — this is what the design's frozen zod `zMessage.msgType` enumerates. The schema *comment*
  (`text|thinking|...`) is informal and NOT canonical. The DB CHECK, zod enum, and `normalizeClaude`
  output all use this union. Source of truth: `MSG_TYPES` tuple exported from `@samskara/core`.
- **D3 — tool-message `content` (design OQ2):** store the block **verbatim JSON-encoded** string.
  Server derives the tool table from the message's `toolCall`/`toolResult` fields regardless, so
  `content` is just the human-readable projection.
- **D4 — `provider` mapping (design OQ3):** at parse time, `claude-*` → `anthropic`, else undefined.
- **D5 — `repoNotWritable` (403):** keep in the `IngestResponse` union for contract stability, but
  no server path returns it yet (step 2 always auto-grants). Documented as reserved.
- **D6 — glob:** injected `glob` dep (default `Bun.Glob` in the real `watch` command, a fake in
  tests) so vitest-under-node isn't coupled to Bun. No new dependency (design: no chokidar).
- **D7 — core dev loop:** server/cli import `@samskara/core` from built `dist`; run tests via
  `turbo run test` (which builds core first via `^build`).

## Phasing (dependency-ordered; ∥ = parallelizable)

- **P0** core package wiring (add `@samskara/core` dep to server + cli, `bun install`).
- **P1** core shared types — ingest contract + collector/plugin types. ∥ with P2.
- **P2** DB schema rewrite + migration 0002 (+ hand-appended triggers) + rewrite db.test.
- **P3** repositories (repos, userRepos, orgRepos, sessions, subagents, messages, toolRows, tokenUsage).
- **P4** reconciliation service `services/ingest.ts` (6-step txn).
- **P5** ingest route (`zValidator` + `requireAuth("cli")`) + mount in app.
- **P6** core collector framework + helpers (registry, readNewLines, iterJsonLines, state). ∥ after P1.
- **P7** Claude adapter (`normalizeClaude` + `readClaudeSidecar` + `collect`).
- **P8** CLI watcher daemon (Sink, driver, `watch` command).

Each phase is TDD: test-first assertions before implementation. Test infra per layer: testcontainers
(`pgvector/pgvector:pg16`) for db/repo/service/route; temp-dir + fake-clock + `InMemorySink` for
watcher; pure temp-fs for core helpers/adapter.
