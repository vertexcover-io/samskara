# Structured Logging Layer

**Verification verdict:** PASSED (functional-verify drove the real server against live Postgres and
the real CLI watch loop, capturing actual NDJSON for every scenario) · **Quality gate:** PASS ·
**Code review:** APPROVE (2-pass)

A coherent, level-based, structured (JSON) logging layer across `@samskara/core`, the server, and
the CLI using pino. A shared `createLogger` factory in core resolves the log level
(`LOG_LEVEL` → `NODE_ENV` default, fail-open on invalid), emits newline-delimited JSON, and redacts a
fixed set of sensitive paths. The server installs one global Hono middleware that mints a `reqId` and
binds a per-request child logger, progressively enriched with `userId` (at auth) and
`sessionId`/ingest context (at the handler); the ingest service takes a `Ctx = { db, log, userId }`
and logs each milestone (project upserted, session/subagent upserted, messages inserted, "Ingestion
completed") *after* it happens. The CLI gains a global `--verbose` flag and structured diagnostics for
every previously-silent watcher branch. Ingestion failures on either side are now diagnosable by
reading logs, and correlatable end-to-end by `sessionId`.

## Artifacts

- [design.md](./design.md) — problem, decisions, F1–F11 requirements, architecture + sequence diagrams
- [spec.md](./spec.md) — EARS requirements, edge cases, verification matrix, VS-1/VS-2 scenarios
- [plan.md](./plan.md) — 3 vertical-slice phases, phase graph, codebase context

Library probe was **skipped** (pino is a well-established dependency); its presence and the
load-bearing `setBindings` API were confirmed at the start of implementation.

## Result

- 3 phases: P1 core `createLogger` factory (walking skeleton), P2 server request logging + `Ctx`-based
  ingest logging, P3 CLI diagnostics.
- 117 tests green (server 74, core 25, cli 17, web 1), typecheck 5/5, lint clean.
- Testing policy (per request): tests cover logging *infrastructure* (factory config, level
  resolution, redaction behavior, middleware binding, `Ctx` refactor, regressions); log wording/level/
  placement verified by code review, not brittle captured-line assertions.

## PR

No PR — this repo has no git remote configured (local-only). The work is on branch
`feat/structured-logging` (5 commits), based on `feat/watch-daemon-ingest`. To open a PR later,
add a remote and `git push -u origin feat/structured-logging`.
