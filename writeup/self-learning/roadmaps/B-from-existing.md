# Roadmap B — Built from what exists

Read-only audit of the self-learning loop. Every status below cites file:line in the current
codebase. No commits, no tests, no edits.

## 1. Verified state of the 13 audit findings

| #  | Finding | Status | Evidence (file:line) |
|----|---------|--------|---------------------|
| 1  | `reviewFromDetail` discards `commits`/`pullRequests` → `shipped` unreachable | **STILL BROKEN** | `packages/server/src/services/review.ts:32-36` calls `reviewEventsFromMessages([...messages])` only. `detail.commits`/`detail.pullRequests` are loaded by `getDetail` (`sessions.repo.ts:835-842`) and thrown away. `events.ts:37-38` defines commit/PR event kinds and `analyzer.ts:124-128` counts them — but nothing projects them from `detail` into the event stream. |
| 2  | `learn --write` clobbers `.harness/knowledge/INDEX.md` with an empty index | **STILL BROKEN** | `packages/cli/src/commands/learn.ts:131-133` regenerates the index from server rows only; `writeLearnings` never reads existing lessons. Test L2 at `learn.test.ts:52-58` explicitly asserts zero rows produce a valid empty index — exactly the clobber path. `exporters.ts:120-141` only knows server-side lessons. |
| 3  | `/api/learnings` had no project-visibility scoping | **FIXED** | `packages/server/src/repositories/reviews.repo.ts:69` joins `visibleToUser(db, userId)` into `listLearnings`. `routes/reviews.ts:46-57` uses it. Matches the per-session visibility model. |
| 4  | `--project <name>` silently dropped (UUID-regex gate) | **STILL BROKEN** | `packages/cli/src/commands/learn.ts:57`: `if (options.project !== undefined && /^[0-9a-f-]{36}$/i.test(options.project))` — name/slug fails the regex, `projectId` is never set, unfiltered fetch runs. No `projectNameById`/`slug→uuid` resolution on the client or via the API. |
| 5  | No acceptance path for candidate learnings | **FIXED (per ruling)** | `routes/reviews.ts:67-81` exposes `PATCH /:id/status` (editor-gated via `canWrite`). `web/src/routes/Learnings.tsx:140-156` renders Accept/Reject/Retire buttons. Human-check-only per RESUME owner ruling 2026-08-26. |
| 6  | No automatic review trigger — manual `samskara review` only | **STILL BROKEN** | `packages/cli/src/watcher/driver.ts:329-369` runs `runCycle` = glob transcripts → `syncSession` → enqueue artifacts → write checkpoints. No call to `reviewAndPersist`. The route `POST /api/sessions/:id/review` exists (`reviews.ts:86-107`) but has no watcher caller. |
| 7  | Subagent tracks pollute analysis; `trackId` never read | **STILL BROKEN** | `events.ts:59-126` projects every message regardless of `trackId`/`agentId`/`isSubagent`. `MessageRow` (`sessions.repo.ts:590-602`) doesn't even return those fields. `analyzer.ts:78-90` increments `userPrompts` from every user message without a track filter. Subagent `agent:` tracks land on the main counter. |
| 8  | `occurrenceCount` inflates on re-review; title overwritten | **STILL BROKEN** | `packages/server/src/repositories/reviews.repo.ts:139-161` `upsertLearning` on conflict sets `occurrenceCount: sql\`${learnings.occurrenceCount} + 1\`` unconditionally (line 153) and overwrites `title`/`detail`/`evidence` (lines 149-151). Re-reviewing the same session adds +1 each time and clobbers the prior magnitude-bearing title. |
| 9  | Absolute edit paths leak into fingerprints; `relativePath` ignored | **STILL BROKEN** | `events.ts:91-93` emits `edit` events with the raw `file_path` from tool input (cwd-prefixed absolute path). `extractor.ts:94-107` fingerprints on that absolute path. The `artifact` table already stores `relativePath` (`schema.ts:485`) but `review.ts` doesn't read it, and the projection never substitutes. Fingerprints split across machines. |
| 10 | Extractor re-derives analyzer counters, threshold hardcoded | **STILL BROKEN** | `extractor.ts:112-121` re-walks events with its own `failuresSincePrompt` (`>= 2` hardcoded); `extractor.ts:138-147` has its own `eventsSincePrompt`; `extractor.ts:160-172` has its own `seqs` walk. Diverges from `analyzer.ts:16` (`FAILURES_BEFORE_CORRECTION=2`). Two counters, one source of truth — extractor can disagree with analyzer. |
| 11 | Stored messages carry no `tokens` → reviews report 0 tokens | **STILL BROKEN** | `events.ts:122-124` reads `message.tokens` for non-usage lines, but `MessageRow` (`sessions.repo.ts:590-602`) has no `tokens` field. `tokenUsage` lives in its own table (`schema.ts:365-373`) and `getDetail` returns totals only (`sessions.repo.ts:781-791`), not per-message. `signals.inputTokens` etc. always 0. |
| 12 | `verify-review-loop.ts` duplicated the suite, deleted anything | **FIXED** | Grep for `verify-review-loop` returns no matches in `*.ts`. RESUME confirms deletion. Native-Postgres test mode (`src/lib/test-db.ts`) covers its purpose. |
| 13 | Assorted: fingerprint lacks analyzer version; 4 constant-subject fingerprints; day-stamped filenames; non-transactional; 201 on replace; aborted from last turnEvent only; R8→R10 gap; dead exports; route path mismatch | **MOSTLY STILL BROKEN** | • `learnings.fingerprint` has no `analyzerName` (`schema.ts:445-475`); cross-version collision. • `extractor.ts:131,156,170,184` fingerprints 4 lessons on the literal subject `"supervision"`/`"prompt-shape"`/`"task-shape"`/`"context-hygiene"` → one row per category, titles overwritten. • `exporters.ts:43-47` puts `date` in the slug → filenames proliferate across days. • `services/review.ts:65-88` `reviewAndPersist` is NOT wrapped in `db.transaction` (compare `ingest.ts:268`). • `routes/reviews.ts:86` returns 201 on every POST, including replace. • `analyzer.ts:163` finds `lastTurn` from the whole event list, so a subagent's `aborted` overrides main's `completed`. • R8→R10 gap: `routes/reviews.ts` has no test file matching that numbering (test exists as `reviews.test.ts` only). • Dead exports: `extractor.ts:REWORK_EDIT_THRESHOLD` etc. exported but unused outside test; `analyzer.ts:HEURISTIC_ANALYZER_NAME` used. • Route mounted at `/api/learnings` (RESUME said `/api/projects/:id/learnings`) — current code at `reviews.ts:41,59` matches the mount. |

**Three findings fixed (#3, #5, #12). Ten still broken (#1, #2, #4, #6, #7, #8, #9, #10, #11, parts of #13).**

## 2. Gap-ranked roadmap (worst-first)

Each item: first concrete step + definition of done.

### G1. Fix commit/PR projection → make `shipped` truthful
**Step:** In `packages/server/src/services/review.ts:32-36`, extend `reviewFromDetail` to iterate `detail.commits` and emit `{ kind: "commit", sha }` events, and `detail.pullRequests` to emit `{ kind: "pullRequest", number }` events, before `runReview`. Add a unit test that asserts `signals.commits > 0` and outcome `shipped` for a session whose `getDetail` returns one commit row.
**DoD:** `packages/core/src/review/analyzer.test.ts` has a test "commit events → outcome shipped"; `services/review.test.ts` has a test `reviewFromDetail emits commit events from detail.commits`; a manual `samskara review <id>` against a real shipped session prints `shipped — work landed (commit or PR)`.

### G2. Make `learn --write` merge, not clobber, the knowledge index
**Step:** In `packages/cli/src/commands/learn.ts` `writeLearnings`, before writing the new index, read every existing `.harness/knowledge/lessons/**/*.md`, parse frontmatter into `KnowledgeLesson` records, dedupe by path against the new server rows, and feed the union into `knowledgeIndexFromLessons`. Replace `L2` (`learn.test.ts:52-58`) with a test that pre-seeds a hand-written lesson in a tmp `.harness/knowledge/lessons/tool-retry/x.md` and asserts the regenerated index contains it alongside server rows.
**DoD:** `learn.test.ts` has `L2-merge`; running `samskara learn --write` against an empty DB preserves the four existing lessons in `docs/.harness/knowledge/lessons/**`.

### G3. Resolve `--project <name-or-slug>` server-side, fail loudly
**Step:** Add `GET /api/projects?name=<x>` (or accept `project` on `GET /api/learnings`) that resolves name/slug → uuid, returns 404 on no match and 409 on ambiguity. `learn.ts:57` sends `project=<value>`; the route resolves and applies the uuid filter or errors out. Add tests for name, slug, uuid, ambiguous, missing.
**DoD:** `samskara learn --project foo --write` against an unrecognised name exits non-zero with a name list; against a slug writes into that project only; against a uuid behaves identically to today.

### G4. Automatic review trigger in the watcher idle sweep
**Step:** In `packages/cli/src/watcher/driver.ts:329-369`, after `syncSession` returns, for each `(sessionId, projectId)` whose `lastMessageAt` has been quiet for N minutes and which has no `sessionReviews` row, POST `/api/sessions/:id/review`. Track per-session "already-requested" in the checkpoint store. Add a test that injects an `InMemorySink` plus a fake review route handler and asserts one POST per idle session per cycle.
**DoD:** Watching this repo for one hour produces ≥1 review row per session whose last activity crossed the idle threshold; no review is re-triggered within the threshold window.

### G5. Make the analyzer track-aware; collapse subagent tracks
**Step:** Extend `ReviewEvent` with `trackId: "main" | "agent:<id>"`. In `events.ts:59-126`, stamp every body with the track it came from (server already has `messages.trackId` at `schema.ts:227`). `analyzer.ts:78-90` filters: only main-track `userMessage` increments `userPrompts`; subagent events count toward a sibling `subagentSignals` and never mix. Add tests.
**DoD:** A session that spawns one subagent with 3 failures shows `userPromptsAfterFailures=0` in the main review; the subagent's own review surfaces those.

### G6. Per-session occurrence semantics + relative-path fingerprints
**Step:** (a) `reviews.repo.ts:139-161` `upsertLearning` should no-op `occurrenceCount` when the upsert's `sourceReviewId` already exists in the row's history; or carry a `seenInSessions` set column and union it. (b) `events.ts:91-93` and `reviewFromDetail`: when the message carries a `repoId` joinable to the session's dominant repo, emit `edit` with the relative path; otherwise drop the edit (don't fingerprint absolute paths). Add fingerprint = `audience:category:subject:analyzerName`.
**DoD:** Re-reviewing the same session 5x leaves `occurrenceCount=1` and `seenInSessions=["<id>"]`; two sessions editing the same relative path produce one fingerprint on both machines.

### G7. Fold token totals into the review input + share analyzer/extractor counters
**Step:** (a) `reviewAndPersist` calls `runReview` with `{ events, tokenUsage: detail.tokenUsage }`; analyzer sums on init. (b) Delete the four local counter loops in `extractor.ts:112-121, 138-147, 160-172, 174-186`; have the extractor take a `DerivedCounters` struct from the analyzer. (c) Wrap `reviewAndPersist` in `db.transaction`.
**DoD:** Review of a 3-turn session reports `inputTokens>0` matching the `tokenUsage` row; the extractor can no longer produce a learning the analyzer's `signals` doesn't justify.

## 3. Watcher cycle — what actually happens every 10 s

`packages/cli/src/watcher/index.ts:152-158` loops:
1. `runCycle` (`driver.ts:329-369`) is called.
2. `readCheckpoints` (line 335) loads per-file `{mtime,size,lineProcessed}` from the state file.
3. `plugin.collect(prev, deps)` is called — today that's `createClaudePlugin(nodeFs)` (`claude.ts:1162-1234`): glob `~/.claude/projects/**/*.jsonl`, classify each path as main or subagent, stat it, drop unchanged files, resolve each directory's cwd via cached `projectForDir`, filter by `shouldCapture` and `syncFromFor` cutoff, then `collectTrack` parses lines after the last checkpoint, normalizes via `normalizeClaude`, and emits a `SessionBatch`.
4. For each batch: `attributeRepos` (line 133) walks every message's cwd through `resolveRepo`. Then per track: `originFor` reads HEAD once for first-time mains (line 229); `syncTrack` (line 157) slices records into ≤2000-message chunks via `sliceByMessages`, calls `collectGitEvents` (`gitEvents.ts:109-164`) to extract commit/PR events from Bash calls (regex on output, gated by `isGitCommitCommand`/`isPrCreateCommand`), POSTs each chunk to `/api/ingest` via the HTTP sink (`sink.ts:38-66`) with `x-request-id`, stops on first non-2xx and retries next cycle.
5. After the flush: `enqueueArtifacts` (line 275) walks `collectArtifacts` + `shouldCaptureArtifacts` containment, writes new entries to the artifact queue. A long-running `runArtifactWorkers` started once outside the loop (`index.ts:129-140`) drains the queue in parallel and uploads to `/api/artifacts`.
6. `writeCheckpoints` (line 368) persists the union of new + prior checkpoints.

**What the cycle does NOT do:** call `reviewAndPersist`. No automatic review trigger exists.

## 4. Opencode plugin seam

**The seam:** `packages/core/src/collector/types.ts:55-58` defines `AgentPlugin` as `{ source, collect(prev, deps) → SessionBatch[] }`. `packages/core/src/collector/registry.ts:1-11` already has `register`/`plugins`/`pluginFor` — the registry exists but **is not wired into the daemon**. `packages/cli/src/watcher/index.ts:116` hard-codes `createClaudePlugin(nodeFs)` instead of iterating `plugins()` from the registry.

**What an opencode plugin would need to do:**
1. Implement `AgentPlugin` with `source: "opencode"`. Implement `collect`: glob opencode's session store (path TBD), parse each session into `ParsedRecord[]` using a sibling `normalizeOpencode` (mirroring `claude.ts:890-941`), classify main vs subagent tracks, produce `SessionBatch[]`.
2. **Schema work:** `packages/core/src/ingest/types.ts:66` has `source: z.literal("claude_code")` — the server's `ingestPayloadSchema` rejects any other source. Loosen to a `z.enum(["claude_code","opencode", ...])` and migrate the existing column default. Add a `MIGRATION_STEPS` entry to relax `messages.source` and `sessions.source` constraints.
3. **Source-specific normalization:** emit `NormalizedMessage` events with the same vocabulary. opencode's tool names likely overlap Claude's; if not, decide whether to remap to the existing union (`toolCall`/`toolResult`/`message`/`turnEvent`) or widen it.
4. **Git events:** if opencode records Bash calls the same way, `gitEvents.ts:76-79` (`isBashCall`) is portable. If opencode uses a different shell tool, add an arm.
5. **Registry wiring:** change `index.ts:116` from `createClaudePlugin(nodeFs)` to `plugins().filter((p) => p.source === "claude_code" || p.source === "opencode").forEach((p) => p.collect(...))` — or have `runCycle` accept `ReadonlyArray<AgentPlugin>` and iterate. Until this happens, registering the plugin via `register(createOpencodePlugin(fs))` is a no-op at runtime.
6. **Project resolution:** `projectForDir` is claude-specific (`claude.ts:1134-1160`); the opencode plugin needs its own equivalent keyed on opencode's directory layout.
7. **Checkpoints:** the `claudeCheckpointSchema` (`types.ts:12-17`) keys on `mtime`/`size`/`lineProcessed`. opencode will likely want its own schema; either generalize the body or extend `checkpointSchema` with a discriminated union on `source`.

**Net:** the registry exists, the contract exists, the server's source-string gate is the only real blocker. Without that relaxation plus wiring `plugins()` into `runCycle`, no second source can land.

## 5. Top 5 risks

1. **Shipped verdict is fiction (G1).** Every "did this session land?" answer the UI/CLI shows today is wrong. Until #1 is fixed, the loop cannot learn what shipping looks like.
2. **Knowledge base silently rewritable (G2).** First realistic `learn --write` against this repo orphans four hand-written lessons in `.harness/knowledge/lessons/`. The very file that exists to anchor agent behaviour is overwritten by a generated stub.
3. **`--project` is a footgun (G3).** A user with five paired projects who types `samskara learn --project myproj --write` writes ALL projects' accepted learnings into `myproj`'s checkout. Help text claims "name or id"; code silently accepts neither.
4. **Watcher is review-blind (G4).** Every review must be triggered manually. There is no path that runs the loop on real, fresh data without a human. Combined with #1 this means real data has never been reviewed truthfully.
5. **Fingerprint instability across machines (G6).** Same lesson, two laptops, two fingerprints. The cross-project `common` view (`reviews.repo.ts:99-127`) can never surface a pattern the team actually shares because no two machines agree on what `Bash` is.
