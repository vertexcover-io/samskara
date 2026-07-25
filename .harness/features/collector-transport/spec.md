# Spec: Collector Transport

Derived from `design.md`. Splits parse (plugin) from transport (framework), restructures the wire
payload to `ParsedRecord`s, and replaces `FileState` with a discriminated `Checkpoint`.

## Requirements (EARS)

**R1 — Plugin owns parse.** WHEN the framework calls `plugin.collect(prev, deps)` once per cycle,
the plugin SHALL discover its files, stat-gate against checkpoints, read + parse changed files into
`ParsedRecord`s, resolve the project, group by session (main track first), and return
`SessionBatch[]`.

**R2 — Stat gate.** WHERE a file's stored checkpoint has matching `(mtime, size)`, the plugin SHALL
skip it with no read. A file with no checkpoint SHALL be read from line 0; a file whose mtime OR
size differs SHALL be read from its `lineProcessed` watermark.

**R3 — No growth, no batch.** IF a session has no changed tracks this cycle, the plugin SHALL emit
no `SessionBatch` for it. IF only a subagent grew, the `SessionBatch` SHALL contain only that track.

**R4 — checkpointAt is pure.** The plugin's `checkpointAt(lineNumber)` SHALL return a `CheckpointBody`
`{ source, mtime, size, lineProcessed }` with no I/O and no mutation.

**R5 — Framework transports.** WHEN `runCycle` runs, it SHALL read checkpoints, call `collect`, run
sessions in PARALLEL via `syncSession`, merge the disjoint checkpoint maps, and persist once
atomically (temp + rename).

**R6 — Sequential tracks, main first.** WITHIN a session, `syncSession` SHALL process tracks
sequentially (main first). IF a track has no `sessionId`, it SHALL be skipped.

**R7 — Sequential chunks + slicing.** `sliceByMessages(records, MESSAGE_CAP)` SHALL slice a track's
records into chunks of at most `MESSAGE_CAP` fanned-out messages, in order. A record MAY straddle a
chunk boundary (same `lineUuid`/`raw` on both chunks).

**R8 — Advance on 2xx only, to last complete line.** WHEN a chunk send returns 2xx, the framework
SHALL call `checkpointAt(chunk.lastCompleteLine)` and record the wrapped `Checkpoint`. On any
non-2xx, it SHALL stop that session's remaining tracks/chunks and NOT advance.

**R9 — No errors in checkpoint.** The checkpoint SHALL record only successful position. Retry counts
and errors go to `deps.log` (success line on 2xx, warn/error on non-2xx), never the checkpoint.

**R10 — Wire payload `records`.** The `IngestPayload` SHALL carry `records: ParsedRecord[]` instead
of `rawLines` + `messages`; `sourceRelativePath` and `title?` flat on the base; `main`/`subagent`
union differs only by the subagent's `agent` block. `NormalizedMessage` drops `lineUuid` +
`lineNumber` (now on the record), keeps `subIndex`.

**R11 — Server adopts records.** The ingest route/service SHALL accept `records`, rebuild
`(lineUuid, subIndex)` from `record.lineUuid + message.subIndex`, stamp `record.lineNumber` and
`record.raw` onto each message row, read `title` from the flat base, and drop the `SessionFields`
block (only `title` survives; `cwd`/`model`/`cliVersion`/`permissionMode` gone from the wire).

**R12 — resolveProject failure.** IF `resolveProject` cannot resolve a starting dir, the plugin
SHALL emit no track for that file (retry next cycle).

## Verification Scenarios

- VS1: grown main file → one main batch, records fanned out, checkpoint advances to last line.
- VS2: restart from persisted checkpoint → no re-send of already-sent lines.
- VS3: unchanged file (matching mtime+size) → skipped, no read.
- VS4: 409 on a chunk → session stops, checkpoint not advanced, retries next cycle.
- VS5: main + subagent same session → single batch, main track first, sequential.
- VS6: torn trailing line → not flushed until completed.
- VS7: large scan (>MESSAGE_CAP messages) → multiple chunks, checkpoint reaches final line.
- VS8: no sessionId → no flush, no checkpoint.
- VS9: parallel independent sessions → one failing doesn't block others.
- VS10: server ingests `records` payload → messages persisted with rebuilt key, lineNumber, raw.
