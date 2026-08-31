# Opencode capture — increment 1

What landed in this commit, the runtime choice, the live proof, and what
deliberately stays out of scope for the next slice.

## What landed

### Source gate and payload wiring
- `packages/core/src/ingest/types.ts:13-21` — `SESSION_SOURCES = ["claude_code", "opencode"]`
  replaces `z.literal("claude_code")` on every `NormalizedMessage`. The Zod
  enum still rejects unknown sources, so a future plugin name is a typed addition,
  not a silent coercion.
- `packages/core/src/ingest/types.ts:444-456` — `IngestPayload` now carries
  `source` so the server knows which agent wrote each flush.
- `packages/server/src/services/ingest.ts:279` — `source` is now read off the
  payload; the hardcoded `"claude_code"` is gone. Sessions and messages inherit
  the per-payload value.

### Source-aware checkpoints
- `packages/core/src/collector/types.ts` — `Checkpoint` is now a discriminated
  union on `source`. Claude checkpoints carry `(mtime, size, lineProcessed)`,
  opencode checkpoints carry `(timeUpdated, lastMessageId)`. A key string
  collision (a file path that happens to look like an opencode session id)
  cannot silently silence the other plugin: `isChanged` (`claude.ts:989-996`)
  and `isCheckpointUpToDate` (`opencode.ts:534-540`) both require a same-source
  match.
- `WatcherDeps.plugin` → `WatcherDeps.plugins: ReadonlyArray<AgentPlugin>`
  (`packages/cli/src/watcher/driver.ts:34-49`). The cycle now iterates
  `deps.plugins`, flattens the batches, and merges checkpoints per source.

### Opencode plugin
- `packages/core/src/collector/plugins/opencode.ts` — `createOpencodePlugin`
  reads opencode's sqlite database (default `~/.local/share/opencode/opencode.db`)
  via a tiny driver shim. Project resolution is the same `resolveProject` flow
  as claude; subagent sessions (`parent_id IS NOT NULL`) are grouped under
  their parent's batch as `subagent` tracks. The `opencode db path` CLI call
  is wired through `resolveDbPath` for the day opencode moves the file.
- `normalizeOpencode` fans out opencode parts into the existing
  `NormalizedMessage` vocabulary: text → message, reasoning → reasoning,
  tool → `toolCall` (+ `toolResult` when status is completed or errored),
  file/patch → fileEvent, step-finish → turnEvent, unknown → custom.
- `packages/cli/src/watcher/gitEvents.ts:79-83` — `isBashCall` now accepts
  both `"Bash"` (claude) and `"bash"` (opencode) so the existing
  commit/PR extraction runs unchanged for opencode bash calls.
- `packages/cli/src/watcher/index.ts:18-37, 119` — `activePlugins(log)` builds
  the registry: claude always, opencode when the database is reachable
  (debug log otherwise). `register()` is now actually called — the registry
  existed but had no callers.

### Tests
- `packages/core/src/collector/plugins/opencode.test.ts` — 17 tests covering
  `normalizeOpencode` (user/assistant text, reasoning, tool+result, custom
  fallback), `createOpencodePlugin` (mains, subagents, checkpoint filtering,
  enablement, cutoff, source-key collision, real-file round-trip), and the
  `defaultDbPath` / `SOURCE` constants.
- Existing core tests (`144 passed`), server tests (`157 passed, 214 skipped`),
  cli tests (`410 passed, 2 pre-existing failures in `learn.test.ts:99` and
  `review.test.ts:128` — both failed identically on master before this change,
  confirmed via `git stash`).

## Runtime choice

The shipped CLI runs on Node 22+; dev runs under bun. Both matter:

- `node:sqlite` would have worked on Node 22+ but needs
  `--experimental-sqlite`. That flag is not something operators should have
  to remember.
- `bun:sqlite` is built into bun but does not exist on plain Node, so it
  cannot be a runtime dependency.
- `better-sqlite3` works on Node 22+ but bun **cannot dlopen it** today
  (bun #4290). Dev (which runs under bun) would crash.

The plugin therefore uses a tiny driver shim (`opencode.ts:34-104`):

- If `globalThis.Bun` is present → `require("bun:sqlite")`.
- Otherwise → `require("better-sqlite3")` (already in the prod tarball).

Both are wrapped behind the same `OpencodeDatabase` / `OpencodeStatement`
interface, so the plugin itself is driver-agnostic. better-sqlite3 stays a
real runtime dependency so the released CLI ships with the right native
binaries; bun:sqlite is used in dev without a flag or extra module.

## Live proof

Restarted the watcher against this repo (`vertexcover-io-samskara`):

```
$ bun packages/cli/src/index.ts restart
Started the capture watcher (process 12409).

$ psql ... -c "SELECT source, count(*) FROM sessions GROUP BY source"
   source    | count
-------------+-------
 opencode    |     9
 claude_code |     4

$ psql ... -c "SELECT source, \"msgType\", count(*) FROM messages
               GROUP BY source, \"msgType\" ORDER BY source, \"msgType\""
   source    |  msgType   | count
-------------+------------+-------
 claude_code | message    |    14
 claude_code | toolCall   |     3
 claude_code | toolResult |     3
 opencode    | custom     |   826
 opencode    | message    |   646
 opencode    | toolCall   |   960
 opencode    | toolResult |   959
 opencode    | turnEvent  |   821
```

9 opencode sessions from `~/.local/share/opencode/opencode.db` landed in
the samskara DB with the right `source = "opencode"`. The 1:1
`toolCall`/`toolResult` ratio (960:959 — one tool was captured mid-run with
`status = "running"`) confirms the normalization emits a real result row
per completed tool, not a synthetic one derived from the toolCall.

## What is deliberately NOT in increment 1

These belong to later slices and are tracked in the gap-ranked roadmap:

- **Review trigger.** The watcher captures opencode sessions but still does
  not call `POST /api/sessions/:id/review` automatically. Audit finding #6
  (roadmap B §2.G4) is unchanged.
- **Per-session review triggers on commits/PRs.** `signals.commits` /
  `signals.pullRequests` are still zero because `services/review.ts:32-36`
  has not been taught to project `detail.commits` / `detail.pullRequests`
  into review events. Audit finding #1 is unchanged.
- **Relative-path edits and per-session occurrence semantics.** Audit
  findings #8 and #9 are still open in the core extractor.
- **Semantic similar-session retrieval.** pgvector store is provisioned but
  unused.
- **Loop-efficacy measurement.** No before/after signal capture per
  accepted lesson.
- **Auto-trigger on idle.** Audit finding #6.

## Files touched

- `packages/core/src/ingest/types.ts` — source enum + payload field
- `packages/core/src/collector/types.ts` — discriminated checkpoint union
- `packages/core/src/collector/plugins/claude.ts` — same-source narrowing on
  read; sets `source: SOURCE` on shared track
- `packages/core/src/collector/plugins/opencode.ts` — new (the plugin)
- `packages/core/src/collector/plugins/opencode.test.ts` — new
- `packages/core/src/index.ts` — exports the new plugin
- `packages/server/src/services/ingest.ts` — payload.source
- `packages/cli/src/watcher/driver.ts` — plugins array; iterates registry
- `packages/cli/src/watcher/driver.test.ts` — fixtures updated for
  source-aware union
- `packages/cli/src/watcher/sink.test.ts` — payload fixture has source
- `packages/cli/src/watcher/gitEvents.ts` — accepts bash / Bash
- `packages/cli/src/watcher/index.ts` — registers both plugins at startup
- `packages/server/src/routes/ingest.test.ts` — payload fixtures have source
- `packages/server/src/services/ingest.test.ts` — payload fixtures have source
- `packages/core/src/collector/plugins/opencode.test.ts` — new tests
- `packages/core/src/index.test.ts` — payload fixture has source
- `packages/core/src/collector/helpers.test.ts` — narrows checkpoint access
- `packages/core/src/collector/plugins/claude.test.ts` — narrows checkpoint
  access
- `packages/core/src/collector/state.ts` — unchanged (Zod handles the union)
- `packages/core/package.json` — `better-sqlite3` and `@types/better-sqlite3`
