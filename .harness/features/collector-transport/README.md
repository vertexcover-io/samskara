# Collector Transport

Splits the watcher's two jobs cleanly: the **plugin parses** (discovers files, stat-gates against
checkpoints, fans lines into `ParsedRecord`s, resolves the project, groups by session) and the
**framework transports** (slices records into request-sized chunks, sends them, advances the
checkpoint only on a 2xx). Adding a new agent later is a new plugin with zero framework edits.

**Verification verdict:** _pending (auto pipeline)._

## What changed

- **Core** — new `ParsedRecord` wire shape (`records` replaces `rawLines` + `messages`, `title`
  flat on the base); `NormalizedMessage` drops `lineUuid`/`lineNumber` (now on the record).
  `FileState` → discriminated `Checkpoint` union + `CheckpointStore`. New `AgentPlugin.collect(prev,
  deps)` returning `SessionBatch[]`; `SessionTrack` carries the payload plus `checkpointKey` +
  `checkpointAt`.
- **Claude plugin** — owns discovery, the `stat`-based change gate, parse into records,
  `resolveProject`, session grouping (main track first), and `checkpointAt`.
- **Framework** (`driver.ts`) — `runCycle`: read checkpoints → `collect` → parallel `syncSession` →
  merge disjoint maps → persist once atomically. `syncSession`: sequential tracks (main first),
  `sliceByMessages` by fanned-out message count, advance on 2xx only to the last fully-sent line,
  stop the session on the first non-2xx. A monotonic-advance guard prevents a mid-line success from
  freezing a file's checkpoint.
- **Server** — ingest route/service adopt `records`, rebuild `(lineUuid, subIndex)` from the record
  + message, stamp `record.lineNumber`/`record.raw`, read the flat `title`, drop the `SessionFields`
  block (only `title` survives on the wire).

## Contents

- [design.md](./design.md) — the design this implements
- [spec.md](./spec.md) — EARS requirements + verification scenarios
- [plan.md](./plan.md) — phased implementation plan
- Library probe: NOT_APPLICABLE (no new external dependencies)

## PR

_pending_
