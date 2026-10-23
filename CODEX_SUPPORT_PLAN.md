# Codex support: codebase assessment and implementation plan

Research date: 2026-10-19. Repository baseline: `0a95d03` (`0.5.2`). The assessment below describes that baseline. Implementation uses the approved capture-first scope and history API decision recorded here; Codex reviewer execution is excluded.

## Selected implementation

Use a local stdio Codex app-server, tested with CLI 0.163.0. No raw-storage fallback or new SDK is added. Read active and archived threads across all source kinds/providers, apply project opt-in and root cutoff before loading history, and retain explicit fidelity gaps. Exact historical usage is unavailable; latest model information belongs to the session snapshot, and missing per-message timestamps/models stay unset.

The implementation extends the existing ingest contract, collector/checkpoint union, watcher activation and shutdown, family-aware replay, parent validation, successful multi-file effects, Git proof validation, local review loading, hooks/init and source labels. Existing text/JSONB columns hold the data, so no migration is required. Stable thread/turn/item identities and per-component acknowledgments let completed results arrive after their calls. Each thread's checkpoint keeps its native update time, the last saved item and the unfinished items; an unchanged update time skips the read, and a changed one reads from the oldest unfinished turn.

Validation includes unit suites with real database tests, native legacy history in the browser capture pipeline, and an actual paginated `codex exec` session driven by a local deterministic Responses fixture. The latter writes a file and makes a real Git commit without credentials or external model calls. The implementation's verification report records command results and the four narrow-screen E2E failures also reproduced on the unchanged baseline.

## Implementation results

The three capture milestones are implemented on `feat/codex-capture`. Native parent relationships include the current parent field and the explicit legacy spawn-source parent when the current field is absent. The reader does not invent missing spawn calls, token reports, message models, timestamps or file bases.

| Check | Result |
| --- | --- |
| Core, CLI, web and server tests | 1,894 passed: 356 + 550 + 370 + 618. Database-backed server tests executed. |
| Typecheck, lint and build | Passed. |
| Codex browser capture test | Passed against the real Codex 0.163.0 history API. |
| Complete browser suite | 54 passed; four existing 320px overflow tests failed. The same four failures reproduced at baseline `0a95d03`. |
| Installed package | Packed and installed in temporary directories; Codex capture, initialization, restart, replay and review dry-run exercised. |
| Manual native capture | Seven records, two shell calls and one real Git commit; restart/replay retained the counts. |
| Legacy history | Pending patch completion uploaded two files; resume added three records. Native archive and replay restored eight records and both files. A family fixture captured two nested children under one root and kept a fork separate. |

The local proof report at `.harness/codex-capture/verification/proof-report.html` contains API evidence, screenshots and videos. It is an untracked verification artifact. It distinguishes manual checks from automated edge-case coverage and records the existing mobile navigation defect. No database migration, Codex reviewer backend or release is included.

## Recommendation

Add Codex as a third **capture source** through the existing collector interface. Reuse the watcher, normalized ingest payload, authorization, database, search, artifact queue, and session viewer. Complete the integration by removing the Claude-specific assumptions in replay, Git evidence validation, local review loading, and UI attribution.

Use Codex's documented history-reading interface. Compatibility probes confirmed legacy and paginated histories on 0.163.0; the integration deliberately accepts gaps in that curated history.

**Running Codex as the AI reviewer is a separate deliverable.** Capturing a Codex session does not require adding Codex to `AI_REVIEW_HARNESS` or provisioning an OpenAI model credential for Samskara. Existing reviewer backends can analyze a properly normalized Codex session.

## Scope and success criteria

Assumption for this plan: “Codex support” primarily means recording a developer's local Codex work, as Samskara already does for Claude Code and OpenCode. The optional reviewer work is listed separately so both meanings are covered.

A complete capture release should let a developer:

1. Initialize Samskara and enable a project on a machine that uses Codex without requiring a Claude installation.
2. Capture supported local Codex conversations, tool calls/results, available usage, and proven subagent relationships.
3. Stop and restart the watcher, resume or archive Codex work, and retry interrupted uploads without missing or duplicating records.
4. Browse and search those sessions with correct Codex attribution, tool status, and branch structure.
5. Capture proven file changes and supported commit/PR evidence under the existing artifact and project rules.
6. Replay a captured session and load it for local review independently of which harness performs that review.

Coverage is limited to history available on the machine running Samskara. Remote-only sessions, inaccessible history, and non-persisted runs need an explicit unsupported/missing-history explanation. A first release should publish its tested Codex versions and local client coverage rather than promise every Codex surface.

## Existing architecture and findings

The repository was swept across `core`, `cli`, `server`, `web`, E2E tests, scripts, packaging, deployment, and existing project guidance. The reads concentrated on capture and every downstream consumer that can change the meaning of a new source. There is no `docs/` directory or ADR index at this baseline.

```text
agent history
  -> core AgentPlugin.collect()
  -> CLI project opt-in + batching + checkpointed upload
  -> POST /api/ingest
  -> messages / tools / usage / subagents / Git evidence
  -> search, session UI, reviews

successful file effects -> CLI artifact queue -> existing artifact API
```

| Area | What the code establishes | Consequence for Codex |
| --- | --- | --- |
| Source contract | `packages/core/src/ingest/types.ts:19` permits only `claude_code` and `opencode`; both normalized messages and payloads use that list. | Add `codex`; send it explicitly. Keep the missing-source fallback for old clients. |
| Collector interface | `packages/core/src/collector/types.ts:60` defines injected filesystem/discovery/project dependencies and batches of tracks with raw records and checkpoint functions. | Add a collector through this interface; do not create another upload pipeline. |
| State | `packages/core/src/collector/types.ts:18` defines source-specific checkpoints. `state.ts:7` parses the whole persisted store. | Extend the union and body types compatibly. Old Claude/OpenCode state must still parse. |
| Activation | `packages/cli/src/watcher/index.ts:31` constructs collectors directly. `core/src/collector/registry.ts` is not used by this startup path. | Export the collector from core and instantiate it in `activePlugins`; registration alone does nothing. |
| Privacy boundary | `collector/types.ts:70` requires the plugin to enforce `shouldCapture`; `watcher/index.ts:149` supplies opt-in and cutoff callbacks. | Check session project identity before loading full history or building upload records. |
| Upload progress | `packages/cli/src/watcher/driver.ts:161` advances checkpoints through successful record chunks. `driver.ts:347` collects plugins with one `Promise.all`. | Preserve acknowledged progress; isolate Codex absence, protocol failures, and malformed sessions so other collectors still run. |
| Database | `packages/server/src/db/schema.ts:205` stores session/message source as text, content/details/raw as JSONB, and subagents separately. | Adding a source alone needs no SQL migration. A changed normalized contract still needs validators and compatibility tests. |
| Message identity | `schema.ts:276` deduplicates by session, line UUID and subindex. `repositories/messages.repo.ts:24` ignores conflicts rather than updating message content. | Identity and completion rules are critical; mutable snapshots cannot be treated as immutable completed messages. |
| Replay | `packages/cli/src/commands/replay.ts:28` matches only `<sessionId>.jsonl` or a directory containing that ID. | Source-prefixed checkpoints and rollout filenames need explicit ownership; otherwise replay deletes server data but cannot recapture it. |
| Git evidence | `watcher/gitEvents.ts:72` consumes neutral shell metadata, but `server/src/services/ingest.ts:145` accepts stored calls only when named `Bash`. | A correct Codex shell mapping will still lose commit/PR evidence until server verification is generalized. |
| Artifacts | `watcher/artifact-extract.ts:28` consumes one `wrote` effect or `fileEvent/edited`; relative paths use the supplied project root. | Multi-file patches, tool-specific cwd, and unavailable bases need deliberate handling. |
| Static reviews | `core/src/review/events.ts:57` recognizes a fixed set of edit-tool names and `file_path`/`filePath`. | Codex patch activity otherwise loses edit/rework signals even when the transcript is captured. |
| Local review | `cli/src/commands/review-session.ts:118` discovers Claude files and invokes `createClaudePlugin`. | Add source-aware loading separately from `--harness`, which selects the reviewer. |
| UI | `web/src/session/records.ts:228`, `AgentRail.tsx:63`, `RecordItem.tsx:342`, and `ArtifactsView.tsx:513` label main-agent work as Claude. | Correct source data must flow into actor labels throughout the viewer. |

The README's statement at line 39 that another harness needs “a plugin and nothing else” is broader than the implementation supports. Update it when this work lands.

## What the official Codex documentation changes

These facts were checked against current official OpenAI documentation, rather than older integration examples:

- `CODEX_HOME` defaults to `~/.codex` and controls local state. SQLite state can have a separate root. Discovery and artifact exclusions must account for configured locations. [Environment variables](https://learn.chatgpt.com/docs/config-file/environment-variables)
- App-server offers passive history reads through `thread/list`, `thread/read`, `thread/turns/list`, and `thread/items/list`. New persistent threads use paginated history; full-history `includeTurns` is deprecated for those threads. Thread IDs and the live tree's session ID are distinct concepts, particularly for forks. [App Server](https://learn.chatgpt.com/docs/app-server)
- Current hooks include `SessionStart`; input includes cwd, session ID, and an optional transcript path. Hooks can live in `hooks.json` beside active config layers. Non-managed hooks require trust, and transcript format is explicitly described as unstable. [Hooks](https://learn.chatgpt.com/docs/hooks)
- `codex exec --json` emits execution events for a process the caller launches. `--ephemeral` avoids persisted rollout files. This is useful for an optional reviewer runner, but does not discover other existing Codex sessions. [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
- The TypeScript SDK starts, continues, and resumes Codex threads. It is unnecessary merely to introduce another normalized capture source. [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)

The exact persisted record schema, complete historical usage availability, and behavior of the installed version's paginated store were **not** validated during this read-only assessment. Fields such as `session_meta`, `response_item`, `event_msg`, `turn_context`, and `token_count` are candidate rollout families to inspect, not an approved parser specification.

## Choose and verify the history reader first

There are two viable ways to supply the existing collector:

| Approach | Reuse and additional work | Fit and limitation |
| --- | --- | --- |
| Read Codex history through app-server | Extend `AgentPlugin` with a Codex implementation backed by a small injected history reader and local stdio process. Add protocol initialization, request correlation, paging, timeout/restart, and process cleanup. | Preferred starting point because it avoids owning undocumented storage layouts. Must prove historical fidelity, concurrent use with the developer's client, and operation without starting inference. |
| Parse local transcripts directly | Follow the Claude plugin's filesystem pattern, with Codex-specific discovery, normalization, and file checkpoints. | Less process management and can preserve exact source records. Accept only for tested releases whose storage contains the required history; format changes and incomplete paginated storage are ongoing maintenance costs. |

Do not implement both transports speculatively. Run the following bounded probe, record the result, then choose one:

1. Use an isolated, sanitized Codex home for a declared CLI release. Prepare representative local interactive, resumed, forked, archived, subagent, tool, compaction, usage, and file-change histories. Include both supported history modes when relevant.
2. With the preferred reader, retrieve history without invoking `thread/start`, `thread/resume`, or `turn/start`. Confirm that connecting and reading do not change a conversation's state or interfere with another client. Process startup may have housekeeping effects; do not describe it as a filesystem read-only guarantee.
3. Compare the returned evidence with the prepared session: prompts, final replies, tool arguments/results/status, timestamps, cwd/model/provider changes, relationships, file changes, and usage. Record which fields are unavailable rather than inventing them.
4. Confirm legacy-history behavior separately; use a full-turn read only where the tested protocol requires it. Consume all result pages and distinguish an unsupported method from an empty session.
5. If the preferred reader omits essential evidence, test direct parsing against the same corpus. Document the tested storage layout, including archive behavior, before selecting it. Do not use `history.jsonl` as a presumed full tool transcript or SQLite internals as an undocumented substitute.

The probe's output is a compatibility matrix and sanitized fixtures, followed by one concrete reader choice. A missing required field must become an explicit scope limitation or a documented alternate approach before implementation continues.

## Collector behavior to implement

### Source, project, and family identity

- Create `packages/core/src/collector/plugins/codex.ts` and its collector tests. If app-server is selected, put protocol/process handling behind an injected reader, for example `packages/core/src/collector/codex-history.ts`, with separate paging/lifecycle tests. Keep normalization independently testable with sanitized native records.
- Add `codex` to `SESSION_SOURCES`, a Codex checkpoint variant to `collector/types.ts`, the plugin export to `core/src/index.ts`, and startup wiring to `cli/src/watcher/index.ts`.
- Resolve projects from the session's actual cwd, using `resolveProject`, `rememberProject`, `shouldCapture`, and `syncFromFor`. Dated history folders are storage locations, not project identities. Cache by cwd or native thread identity so unrelated repositories cannot share an attribution entry.
- Retain cached identity for removed worktrees, as the existing collectors do. Unresolvable sessions are skipped with useful diagnostics, not guessed into a project.
- Apply the root session's start cutoff to its family, preserving whole-session context. An old session resumed today should not bypass the configured cutoff.
- Keep forked conversations distinct in Samskara. Retain inherited conversation as context; use a proven fork boundary to avoid counting inherited execution/usage as newly performed work. If that boundary is unavailable, record the counting limitation in the compatibility matrix. Attach actual subagent threads to their proven parent; do not infer that every fork or related thread is a subagent. Preserve child identity, immediate parent, spawn call, and root ownership where the source proves them.
- Build main tracks before children and detect changed children independently of a quiet parent. If the server has lost a parent session, recover its main track before endlessly retrying child uploads that receive 409.

The current `agentInfoSchema` carries spawn depth/call ID, but no direct parent ID (`ingest/types.ts:470`). `server/src/repositories/subagents.repo.ts:41` infers nested parents through the spawn call, and requires depth greater than one. Supply that proven linkage when available. If Codex exposes only an explicit parent thread ID, add a compatible optional parent field and validate it within the same root session before persisting it; the database already has `parentAgentId`.

### Normalize evidence once

Use the existing normalized vocabulary rather than exposing Codex storage keys to downstream code:

| Source evidence to verify in fixtures | Samskara representation and rule |
| --- | --- |
| Human text or supported image input | `message`, role `user`, one stable subindex per content block. Preserve supported image encoding; do not upload arbitrary local image paths without the existing capture policy. |
| Assistant reply or visible reasoning summary | `message`, role `assistant`, content `text` or `reasoning`. Do not fabricate unavailable reasoning text. |
| Instructions, injected context, compaction summary | Appropriate system/developer or typed injected message/compaction record. Do not count these as additional human prompts. |
| Function, custom, or MCP tool call | `toolCall` preserving native name, parsed/redacted input, and correlated call ID. Non-JSON custom-tool input must remain representable. |
| Shell/exec call | Add validated `{ type: "shell", command }` metadata and the actual execution cwd. Preserve native names; do not rename tools to `Bash` to satisfy consumers. |
| Tool result / command progress | `toolResult` with proven terminal status, or `progress` while running. A command returning a process/session handle is not necessarily finished; later polling can contain its real exit and output. |
| Turn completion/interruption | Map success to `turnEvent/completed` and interruption/failure to `aborted`, retaining the native outcome in `reason` and raw evidence. The current status enum is `completed`, `aborted`, `unknown`; it does not accept `failed`. |
| Successful patch/file operation | Neutral file effects for every proven affected path. Failed or cancelled operations do not create successful write effects. |
| Usage | One authoritative `usage/tokens` report per accounting unit, with the rules below. |
| Unrecognized event | Redacted `custom`/`systemEvent` plus raw evidence and an unknown-type diagnostic. A future event type must not break the whole watcher. |

If multiple source records describe the same conversation or tool event, choose one canonical representation. Keeping both as conversation/tool records would duplicate the transcript and distort reviews.

Every `ParsedRecord` requires a valid UUID, positive sequence number, and nonempty message tuple (`ingest/types.ts:377`). Derive UUIDs with the shared `uuidV5` helper from source, native thread/track, and stable item identity. Do not derive identity from absolute storage paths or collection time. Use deterministic synthetic ordinals where the source has no line number; timestamps cannot safely serve as the database's integer line number.

### Checkpoints, replay, and mutable records

For a history API reader, store native thread/root ownership plus the tested incremental marker. Map each output record's sequence number to its acknowledged checkpoint through `checkpointAt`; an opaque page cursor alone is not the driver's record-level progress marker. Keep unfinished work eligible for another scan and handle changes that arrive during pagination.

For a file reader, track complete lines and file identity/size/mtime, tolerate an unfinished trailing line, and detect shrink/replacement. Archive relocation must retain logical identity. Never mark a partially acknowledged upload as fully synced.

In either case:

- Preserve stable subindices between repeated reads. Prefer immutable completed content; emit a call when its arguments are final and its result when it reaches a terminal state. If an API mutates completed records, explicitly design revision/update handling: `onConflictDoNothing` will otherwise keep stale content forever.
- Store session ownership on new checkpoints and make replay use it. Keep the old filename matching only as a compatibility fallback for existing checkpoints. Clear all matching main/child checkpoints, artifact hashes, and queued uploads while preserving server scope and the cached project map.
- Record previously acknowledged history when a reader reconnects or native pagination cursors expire. Rescanning with stable identities is safer than assuming an old cursor remains valid.
- Preserve the existing API-server scope and profile rules; a Codex home is not a replacement for `SAMSKARA_HOME`.
- Treat source truncation/revert/deletion explicitly. Recommended first behavior is to preserve already captured evidence until Samskara deletion or replay; document this archival behavior instead of pretending ingest mirrors source deletions.

### Usage must remain additive

`server/src/services/ingest.ts:226` accepts token reports and `repositories/sessions.repo.ts:934` sums all stored token rows. Therefore a repeated cumulative Codex total cannot be uploaded as a new independent usage record each time.

Prefer verified per-turn/request usage. If only cumulative reports exist, compute nonnegative deltas against the appropriate preceding baseline, including across watcher restarts; handle counter resets explicitly. Choose one report family when both event and response records repeat usage. Preserve cached and reasoning counts in their existing fields, and verify whether they are subsets of input/output before presenting totals. Attach usage once, not once per text/reasoning block. If history cannot recover usage, report the limitation rather than generate estimates.

## Downstream work required for parity

### Git evidence and origin

Change `services/ingest.ts` and `repositories/toolRows.repo.ts` so commit/PR verification recognizes validated normalized shell metadata, while retaining the command-intent checks. Restrict legacy command extraction to the legacy cases it was intended to support; simply dropping the `Bash` name guard would also accept arbitrary non-shell inputs containing a `command` field.

Test native Codex call IDs, terminal exec output, a call/result split across upload chunks or watcher cycles, failed commands, and a non-shell tool returning commit-shaped text. Keep the existing limitation that only observed command/output evidence can establish commits or PRs.

`watcher/driver.ts:234` currently samples HEAD at first upload. For historical imports, that is not necessarily the original starting commit. If verified Codex launch metadata contains the original commit/cwd, pass that origin through without later HEAD sampling overwriting it; otherwise disclose the unavailable origin.

### File changes and review signals

The existing `wrote` metadata holds one path and an optional complete base (`ingest/types.ts:102`). Prefer a compatible neutral multi-effect result representation for multi-file operations, retaining existing `wrote` support. Update the artifact extractor and review event projection together. Emitting existing `fileEvent/edited` per path is a smaller fallback but cannot express creation/base information accurately.

Resolve paths against the relevant tool/turn cwd before enqueueing. Track patch additions, updates, moves, and deletions accurately in transcript evidence; upload current bytes only when available. A patch hunk is not a complete pre-session file. Use the existing unknown-base artifact behavior when the original file cannot be reconstructed.

Use neutral successful effects for edit/rework detection in `core/src/review/events.ts`, and verify the server's `services/review.ts` projection yields the same result as local analysis. Preserve prior-source behavior where legacy edit inputs remain necessary.

Extend `watcher/containment.ts` to exclude the default and configured Codex state roots from artifact capture. Reuse canonical-path containment, secret checks, size caps, hashing, and artifact worker retries. Shared `redactJson` redacts structured sensitive keys and removes NUL characters; it is not a general secret detector inside prose or shell strings. Decode structured tool arguments before applying redaction, and protect raw records too.

### Correct attribution in the web UI

Derive a main-agent display name from `session.source`, with a sensible fallback for future sources. Pass it into the timeline, agent rail, branch return labels, artifact attribution, and tool/event wrappers. Relevant files are:

- `packages/web/src/session/records.ts`
- `packages/web/src/session/AgentRail.tsx`
- `packages/web/src/session/RecordItem.tsx`
- `packages/web/src/session/ArtifactsView.tsx`
- `packages/web/src/routes/SessionDetail.tsx`

The detail API already returns `session.source` (`sessions.repo.ts:840`). Reuse it; introduce per-message source only if a real mixed-source requirement appears. Preserve the design's rule that inferred or missing evidence is labelled (`packages/web/DESIGN.md:138`). Show native tool arguments/results with existing generic renderers before adding special presentations.

Also remove the tool-name gate around proven spawn-call placement: `records.ts:189` recognizes only `Agent`/`Task`, and line 366 filters other names before joining `spawnToolUseId`. Join verified spawn relationships independently of native tool names so Codex branches appear at their actual spawn call, including inside nested branches, rather than falling back to child timestamps.

Search, permissions, project membership, sync status, tagging endpoints, and ordinary artifact serving already operate on normalized records or session IDs. They need regression coverage, not replacement implementations. A new source filter is a separate optional product feature.

### Initialization, hooks, and CLI commands

`commands/install-hooks.ts:32` edits only Claude settings and `commands/init.ts:151` always calls it. Add source-specific hook installation for Codex's supported `SessionStart` mechanism. Preserve unrelated hooks, make installation idempotent and profile-aware, and explain that a newly installed or changed Codex hook may still need trust. Existing `ensure` output is already shaped as `SessionStart` JSON; verify compatibility and use the hook's actual cwd rather than assuming the launch directory.

Daemon capture must also work when a hook is disabled or unsupported: `init`/`enable` can start the watcher, and `watch`/`restart` remain explicit recovery commands. Hooks should revive/check capture, not become a second transcript upload path. Do not silently edit Claude settings for a Codex-only setup.

Generalize `review-session`'s history lookup/loader and its help text. Add an input-source selector if IDs cannot be resolved unambiguously. Keep reviewer `--harness` separate: reviewing a Codex transcript with Claude/OpenCode should work without a Codex reviewer backend.

`commands/tags.ts:43` only infers `CLAUDE_CODE_SESSION_ID`. Explicit `--session-id` already works. Keep that fallback and update guidance; add Codex environment-based inference only after verifying a supported variable in the target execution context. Do not assume one from its name.

## Delivery sequence

Implementation should follow repository TDD conventions. These are capability milestones; all capture milestones are needed before advertising parity.

| Milestone | User-visible result | Main work and proof |
| --- | --- | --- |
| 1. Capture one supported local Codex session | An enabled Codex project appears in the real web viewer with text, tools, available usage, and correct attribution. | Complete compatibility probe; choose reader; add source/checkpoints/plugin/startup wiring and basic labels. Prove disabled-project exclusion and repeated-scan dedupe through watcher -> API -> database -> browser. |
| 2. Keep capture correct across lifecycle changes | Resume, archive, forks/subagents, watcher restart, failed uploads, and replay preserve the right history. | Finish family identity, per-record checkpointing, completion rules, pagination/relocation, usage accounting, replay ownership, and error isolation. Exercise a second source concurrently. |
| 3. Complete workflow parity | Files and Git evidence appear, review signals survive, and a Codex-only user can initialize and recover capture. | Add successful multi-file effects, containment exclusions, server shell verification, local review loading, hook support, CLI guidance, and remaining UI attribution. Run full functional acceptance and update docs. |
| Optional: run the reviewer with Codex | `--harness codex` / server reviewer options can execute the existing review contract. | Separate runner/auth/config/deployment work described below. Do not make capture wait for it. |

Do not refactor the unused plugin registry, redesign authentication, add another database, or introduce the Agents SDK merely to deliver these milestones. Keep the chosen Codex reader injected so fixtures and failures can be tested without model access.

## Test and verification plan

Use the existing Claude/OpenCode collector tests, watcher tests, server ingest tests, and `e2e/capture-pipeline.spec.ts` as patterns. Add sanitized Codex fixtures derived from the supported release; generated lookalikes alone cannot establish compatibility.

| Level | Scenarios that must be demonstrated |
| --- | --- |
| Reader/normalizer | Complete history across pages or files; supported legacy/current history; unknown events; malformed source input; text/image/reasoning; injected context; native tool/custom input; redacted raw and decoded arguments. |
| Identity/state | Rescan/restart/resume retain IDs and subindices; incomplete item later finishes; upload fails after an earlier chunk succeeds; cursor invalidation; file shrink/replacement when using files; archive movement; replay clears all owned checkpoints. |
| Attribution/privacy | Two projects sharing a history date folder remain distinct; disabled project; default cutoff and `--all`; deleted worktree; custom Codex home; Codex state and symlink escapes cannot become artifacts. |
| Families | Parent before child; changed child with unchanged parent; nested agent; orphan child; fork stays independent; parent missing on server; duplicate imported ancestor history has a declared policy. |
| Usage | Multiple reports of the same usage; cumulative totals; counter reset; restart baseline; cached/reasoning fields; multi-block output counted once; unavailable usage stays unavailable. |
| Git/artifacts/review | Terminal command result after polling; cross-chunk call/result; positive commit/PR proof; non-shell lookalike rejected; failed patch; multi-file creation/edit/move/delete; unknown base; local/server edit-signal parity. |
| API/UI | `codex` payload validation; old-source compatibility; correct actor labels and branch navigation; proven spawn-call placement in main/nested branches; native tools/results; search returns Codex evidence; existing project visibility applies; legacy sessions keep their labels. |
| Onboarding | Codex-only initialization; idempotent hooks preserving unrelated settings; custom root/profile; hook untrusted/disabled; watcher restart; explicit session ID for tags; source selection independent of reviewer harness. |

Reuse an isolated HOME and `SAMSKARA_HOME` in process-level tests, and explicitly set/clear inherited Codex root variables. If real Codex process tests run through Turbo, account for its environment allowlist in `turbo.json`; do not let a fixture accidentally use the developer's real state. Canonicalize filesystem fixture roots and verify current containment rules rather than copying stale examples from lesson documents.

Validation commands for the implementation:

```sh
bun run test:core
bun run test:cli
bun run test:server
bun run test:web
bun run typecheck
bun run lint
bun run build
bun run e2e
```

Run `bun run test:scripts` if scripts change. Confirm Docker-backed server tests actually execute; the repository can skip them when Docker is unavailable. Finish with a controlled real Codex session on a supported release: enable a disposable project, capture work, restart, resume, inspect browser/search/files/Git evidence, and replay. Record counts and expected omissions against the original history. Test success without this flow does not prove actual Codex compatibility.

These commands apply to implementation validation. Results are recorded in the implementation verification report; the original baseline assessment itself ran no implementation tests.

## Optional: Codex as the AI reviewer

This extends the **execution** side of Samskara, independently of transcript capture:

| Files/area | Required change |
| --- | --- |
| `core/src/review/harness.ts` | Add a reviewer enum entry, configurable model default, credential policy and installation guidance. Verify an accessible model at implementation time. |
| `core/src/review/runner.ts`, `core/src/index.ts` | Add/export `createCodexRunner`; use a fresh workspace-specific Codex state directory, bounded output, timeout/process-tree termination, and the existing `HarnessRunner` contract. |
| `cli/src/commands/review-session.ts` | Add runner dispatch while keeping transcript source independent. |
| `server/src/lib/env.ts`, `server/src/app.ts`, `server/src/routes/reviews.ts` | Extend validation, runner selection, credential checks, installed/available reviewer options, and model lists. |
| `server/src/services/ai-review/pipeline.ts`, `transcript.ts` | Preserve `review.xml` as the deliverable, XML recovery/grounding validation, reviewer transcript collection before cleanup, and meaningful failure reporting. |
| `web/src/api/review.ts`, `components/AnalyzeDialog.tsx` | Extend the hardcoded harness union and unavailable-reviewer copy; consume server availability. |
| `server/src/scripts/setup.ts`, `.env.example`, `Dockerfile`, deploy templates/scripts/workflows, `turbo.json` | Provision the chosen credential, install/pin the binary, propagate required environment/build settings, and update deployment tests and docs. |

Start with a headless `codex exec` runner, not a custom agent loop. Prefer explicit `CODEX_API_KEY` for the automated lane; official environment guidance documents that variable for exec. Isolate state from the user's history and give the child only the credentials it requires. [Environment variables](https://learn.chatgpt.com/docs/config-file/environment-variables)

The existing review contract writes `review.xml`, so the selected sandbox must permit that workspace write without interactive approval. Keep external isolation as an explicit deployment decision: changing the working directory or Codex home does not confine filesystem reads. The existing hardened runner bootstraps OpenCode specifically; extending it to Codex requires its own tested guest setup. Do not copy permission-bypass flags between CLIs.

If using JSON stdout, separate event logging from the final response and retain failure/interruption information; progress text is not a successful deliverable. Test a stub process for arguments/env/timeouts and a controlled authenticated run for actual XML output and grounding. No new generic OpenAI API client is required by this design.

## Compatibility, release, and documentation

- Deploy the server accepting `source: codex` before distributing the CLI that sends it; an older server's shared validator rejects the new value.
- Preserve existing checkpoint variants. New Codex state may be unreadable by an older CLI, so document the downgrade boundary and provide recovery rather than silently dropping unrelated checkpoints.
- Source text and existing JSONB storage should avoid a migration for basic capture. Generate migrations only if the final design changes persisted SQL structure; use the full `db:migrate` workflow and camelCase schema conventions from `CLAUDE.md`.
- Update README capture/discovery/setup/replay/review sections and the stale Claude-only inventory in `packages/web/PRODUCT.md`. Document version/client coverage, custom home behavior, hook trust, unavailable history, file/base limitations, and the distinction between capture source and reviewer harness.
- Core is bundled into the published CLI (`scripts/pack-cli.ts`); verify the reader and any assets survive packing. Use the existing shared-version release workflow instead of editing version fields manually.
- Capture alone does not require installing Codex in the server image. Reviewer execution does. Existing Samskara server setup still requires its configured reviewer credential; this plan does not change that boot requirement.

The compatibility probe selected the history API. Keep its fixtures and the observable capture-to-viewer checks when changing the reader or upgrading the tested Codex release.
