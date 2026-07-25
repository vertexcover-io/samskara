# SPEC: Structured Logging Layer

**Source:** .harness/features/structured-logging-layer/design.md
**Generated:** 2026-07-24

## Requirements

| ID | Type | Requirement | Acceptance Criterion | Priority |
|----|------|-------------|---------------------|----------|
| REQ-001 | Ubiquitous | The system shall expose a `createLogger(base, level?)` factory in `@samskara/core` that returns a pino logger stamped with the caller-supplied `base` fields (including a mandatory `service`). | A logger built with `{service:"x"}` emits lines containing `"service":"x"`; `base` fields appear on every line. | Must |
| REQ-002 | Event-driven | When `LOG_LEVEL` is set to a valid pino level, the system shall use that level. | With `LOG_LEVEL=warn`, a `logger.info(...)` produces no output and `logger.warn(...)` produces output. | Must |
| REQ-003 | Unwanted | If `LOG_LEVEL` is unset, then the system shall default to `info` when `NODE_ENV=production` and `debug` otherwise. | `NODE_ENV=production` + unset `LOG_LEVEL` → resolved level `info`; `NODE_ENV=development`/unset → `debug`. | Must |
| REQ-004 | Unwanted | If `LOG_LEVEL` is set to an invalid value, then the system shall fall back to the NODE_ENV default, emit a single warning, and not throw. | `LOG_LEVEL=chatty` → resolved level equals the NODE_ENV default; construction returns a logger (no throw); one warning emitted. | Must |
| REQ-005 | Ubiquitous | The system shall emit newline-delimited JSON to the process standard stream with no pretty transport. | Each emitted line is valid JSON parseable by `JSON.parse`; output contains no ANSI/pretty formatting. | Must |
| REQ-006 | Ubiquitous | The system shall redact the paths `token`, `authorization`, `*.token`, `req.headers.authorization`, `password`, `secret` from log output. | A line logged with `{token:"abc", password:"p"}` shows `[Redacted]` (or omission) for those keys, not their values. | Must |
| REQ-007 | Event-driven | When a server request is handled, the middleware (registered before the first `app.route`) shall generate a request id (`x-request-id` header if present, else `randomUUID()`) and bind a child logger to `c` via `c.set("log", …)` carrying `{reqId, method, path}` plus `userAgent` when present. | `c.get("log")` is defined inside any handler; its lines carry `reqId`, `method`, `path`; response echoes `x-request-id`. | Must |
| REQ-008 | Event-driven | When the response resolves, the logging middleware shall log one completion line at `info` with `{status, ms}`. | Exactly one line with msg indicating completion, containing numeric `status` and `ms`, per request. | Must |
| REQ-009 | Event-driven | When `requireAuth` resolves a user, the system shall enrich the request logger with `userId` via `setBindings` on the stored instance. | After auth, `c.get("log")` lines carry `userId`; the instance is the same object set in REQ-007 (not replaced). | Must |
| REQ-010 | Ubiquitous | The system shall pass a service context object `{ db, log, userId }` to the ingest service, where `log` is the request child logger enriched with `{sessionId, eventCount, repo, isSubagent}`. | `ingest(ctx, payload)` receives a `log` that carries the request bindings; the handler set them via `setBindings`. | Must |
| REQ-011 | Event-driven | After the ingest DB transaction resolves successfully, the system shall log one completion line at `info` reading "Ingestion completed" with `{sessionId, accepted, duplicates, eventCount}` (mapping service `ingested`→`accepted`, `deduped`→`duplicates`). | Logged after the tx, human-readable message, correct counts. | Must |
| REQ-011a | Event-driven | After each ingest sub-step, the system shall log at `info`: project upserted (with project id/slug), session created/updated or subagent upserted (with sessionId), and messages inserted (with inserted/deduped counts); granular detail (tool rows, token usage) at `debug`. | Each milestone logs one human-readable line *after* the step, at the specified level. | Should |
| REQ-012 | Unwanted | If ingest cannot find the parent session, then after the lookup the system shall log at `warn` the message "No ingest session found with id: {sessionId}". | A subagent ingest with missing parent session produces one `warn` line naming the sessionId. | Must |
| REQ-013 | Unwanted | If a server handler throws, then the `onError` handler shall log at `error` through `c.get("log")` when present, else the server root logger. | A thrown error yields one `error` line with an `err` object; carries `reqId` when the request logger exists. | Must |
| REQ-014 | Event-driven | When the server starts listening, the system shall log the "listening" line through the server root logger (replacing `console.log`). | Boot produces a JSON line via the root logger containing the port; no bare `console.log` remains in `index.ts`. | Must |
| REQ-015 | Ubiquitous | The CLI shall resolve a root logger via `createLogger` with `service:"samskara-cli"`. | CLI log lines carry `"service":"samskara-cli"`. | Must |
| REQ-016 | Event-driven | When the CLI is invoked with the global `--verbose` flag, the system shall raise the effective log level to `debug`. | `samskara --verbose watch` sets level `debug` regardless of NODE_ENV; without it, level resolves per REQ-002/003. | Must |
| REQ-017 | Event-driven | When `flushFile` skips a file because it has no messages, the system shall log at `debug` with `{path}`. | Empty-messages branch emits one `debug` line with `path`; no `info`/`warn`. | Must |
| REQ-018 | Unwanted | If `flushFile` cannot determine a `sessionId`, then the system shall log at `warn` with `{path}`. | Missing-sessionId branch emits one `warn` line with `path`. | Must |
| REQ-019 | Unwanted | If `sink.send` returns a non-2xx status, then the system shall log at `warn` with `{path, sessionId, status}`. | Non-2xx branch emits one `warn` line with `path`, `sessionId`, and `status`. | Must |
| REQ-020 | Event-driven | When `flushFile` uploads a file successfully (2xx), the system shall log one outcome line at `info` with `{path, sessionId, status, messageCount}`. | Successful send emits one `info` line carrying those four fields. | Must |
| REQ-021 | Unwanted | If a watch cycle throws, then the system shall log the full error object at `error` (`{err}`), not only `error.message`. | Cycle failure emits one `error` line whose `err` carries the stack/cause, not just the message string. | Must |
| REQ-022 | Ubiquitous | The system shall never pass raw event bodies (`content`, `thinking`, `raw`) to the logger; ingest paths log counts and ids only. | Log call sites pass only counts/ids (verified by code review, not a captured-line test). | Must |
| REQ-023 | Ubiquitous | The system shall log every action *after* it completes, never before (no "starting X" lines preceding the work). | Each log statement follows the operation it describes. Verified by code review. | Must |

## Edge Cases

| ID | Scenario | Expected Behavior | Derived From |
|----|----------|-------------------|-------------|
| EDGE-001 | `LOG_LEVEL=chatty` (invalid) at logger construction | Fall back to NODE_ENV default, warn once, return a working logger (no throw) | REQ-004 |
| EDGE-002 | Client supplies `x-request-id` header | Trust and reuse it as `reqId`; echo it back on the response | REQ-007 |
| EDGE-003 | Request arrives with no `x-request-id` | Generate a `randomUUID()` reqId | REQ-007 |
| EDGE-004 | Enrichment order: auth (userId) then handler (sessionId) | Both bindings present on the single stored logger instance; no re-childing loses earlier bindings | REQ-009, REQ-010 |
| EDGE-005 | Error thrown before middleware sets `c.get("log")` | `onError` falls back to the root logger | REQ-013 |
| EDGE-006 | CLI paged upload (line-cap) sends a file across multiple `sink.send` calls | One success outcome line per successful send (one per page) | REQ-020 |
| EDGE-007 | A payload carries a `token`/`password` field | Value is redacted in output | REQ-006 |

## Verification Matrix

**Testing policy (per user):** tests cover the logging **infrastructure** — factory configuration,
level resolution, redaction behavior, that the middleware binds a request child logger, that
`setBindings` enrichment and the `Ctx` object thread through, and that existing behavior does not
regress. Tests do **not** assert the content/level/wording of individual emitted log lines (message
wording, per-step lines, outcome fields). Those are verified by code review against REQ-011/011a/012/
022/023, not by capturing output. This keeps tests from coupling to log copy the user will keep tuning.

| REQ/EDGE ID | Test Level | Test Name | Rationale for Level | Notes |
|-------------|-----------|-----------|---------------------|-------|
| REQ-001 | unit | test_REQ_001_factory_returns_logger_with_base | factory returns a usable pino logger; `.child`/`.setBindings` exist | no line-content assert |
| REQ-002 | unit | test_REQ_002_env_level_honored | pure env→level logic | resolveLevel({LOG_LEVEL:"warn"})==="warn" |
| REQ-003 | unit | test_REQ_003_nodeenv_default_level | pure env→level logic | prod→info, else→debug |
| REQ-004 / EDGE-001 | unit | test_REQ_004_invalid_level_failopen | pure fail-open logic; no throw | resolveLevel({LOG_LEVEL:"chatty"}) returns default |
| REQ-006 / EDGE-007 | unit | test_REQ_006_redacts_sensitive_paths | redaction behavior via a capturing destination | the ONE output-content test — proves the security guard (F4) |
| REQ-007 | integration | test_REQ_007_middleware_binds_request_logger | crosses Hono context; asserts `c.get("log")` is a logger + response echoes x-request-id | not the line body |
| REQ-009 | integration | test_REQ_009_auth_sets_userId_binding | auth path does not throw and request still succeeds with middleware present | structural, not line content |
| REQ-010 | unit | test_REQ_010_ingest_accepts_ctx | `ingest(ctx, payload)` accepts `{db,log,userId}` and behaves identically | service-signature refactor |
| REQ-013 / EDGE-005 | integration | test_REQ_013_onerror_returns_500_no_crash | a throwing route yields 500 via onError with + without request logger | behavior, not the error line |
| REQ-014 | unit | test_REQ_014_no_console_log_in_boot | assert `index.ts` uses the root logger, no `console.log` | source assertion |
| REQ-016 | unit | test_REQ_016_verbose_sets_debug | pure flag→level logic | cliLogger(true).level==="debug"; service field set |
| REQ-008,011,011a,012,015,017–023 | — | (code review) | log wording/level/placement is reviewed, not unit-tested | per testing policy above |
| EDGE-002 | integration | test_EDGE_002_propagates_request_id | context boundary | supply x-request-id, assert echoed on response |
| EDGE-003 | integration | test_EDGE_003_generates_request_id | context boundary | omit header, assert a uuid echoed |
| EDGE-004 | — | (covered by REQ-009 structurally) | bindings accumulate on one instance — asserted via no-throw + single-instance code review | |
| EDGE-006 | unit | test_EDGE_006_paged_upload_still_works | existing paging test stays green with logger dep added | regression guard |

**Regression guards (must stay green):** the existing `driver.test.ts` (8 tests) and
`services/ingest.test.ts` (~10 tests) continue to pass after the `WatcherDeps.log` and `ingest(ctx,…)`
changes — these are the "shared code touched" regression scenarios.

## Verification Scenarios

### VS-1: Trace a successful ingest end-to-end by reqId/sessionId

1. Start the server and CLI at default level (`info`). → Boot logs one JSON "listening" line via the root logger (REQ-014).
2. CLI discovers a session file and uploads it. → CLI emits one `info` outcome line `{path, sessionId, status:200, messageCount}` (REQ-020).
3. Server receives the request. → Server emits a request child logger with `{reqId, method:"POST", path:"/api/ingest"}`; after auth the same lines carry `userId` (REQ-007, REQ-009).
4. Ingest handler runs; `ingest(ctx, payload)` receives `{db, log, userId}` (REQ-010). → After each sub-step, an `info` line: "Project upserted", "Session created/updated" (or "Subagent upserted"), "Messages inserted" with counts (REQ-011a); after the tx, one `info` line "Ingestion completed" `{sessionId, accepted, duplicates, eventCount}` (REQ-011). All logged *after* the action (REQ-023).
5. Response returns. → One `info` completion line `{status:200, ms}` (REQ-008); response echoes `x-request-id` (EDGE-002/003).
6. Grep the same `reqId` → every server line for the request is returned; grep the same `sessionId` → both the CLI outcome and server outcome lines are returned (NF1).

### VS-2: Diagnose a dropped session with raised verbosity

1. Run the CLI with `--verbose` (level `debug`) against a session file that yields no messages. → One `debug` line `{path}` "nothing to ingest" (REQ-017); at default `info` this line is absent.
2. Point the CLI at a file where `sessionId` cannot be resolved. → After the skip, one `warn` line `{path}` "Skipped file: no sessionId resolved" (REQ-018).
3. Make the server reject an upload (non-2xx). → After the send, CLI emits one `warn` line `{path, sessionId, status}` "Upload rejected by server" (REQ-019).
   On the server, the subagent-with-no-parent case logs `warn` "No ingest session found with id: {sessionId}" (REQ-012).
4. Force a cycle to throw. → One `error` line whose `err` carries the stack (REQ-021).
5. Confirm no line at any level contains raw `content`/`thinking`/`raw` values (REQ-022).

## Out of Scope

- **`ip` / `x-forwarded-for` capture** — deferred; no reverse proxy is configured. `userAgent` is captured; `ip` is not.
- **Pretty/colorized transport** — raw NDJSON in all environments only.
- **Instrumenting the `drizzle-kit migrate` / seed scripts** — migrations do not run in the server process; only the "listening" boot line is logged.
- **Log shipping / aggregation / rotation** — stdout NDJSON is consumed by the platform; no in-app shipping.
- **`x-request-id` validation** (length/charset caps) — trusted as an internal service; add if untrusted client ids are ever forwarded.
- **Changing the ingest service contract** — the service still returns `{ingested, deduped}`; the `accepted`/`duplicates` vocabulary is applied only at the log site.
