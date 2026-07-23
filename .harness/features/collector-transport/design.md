# Design: Collector Transport — how the watcher parses and ships

This evolves the watcher built in [watch-daemon-ingest](../watch-daemon-ingest/design.md). Nothing
about *what* we capture changes; this is about *how* the client discovers, parses, and sends it.

The old watcher tangled two jobs together. This design splits them cleanly:

- **The plugin parses.** It finds its own files, reads the new lines past the last checkpoint,
  turns them into messages, resolves the project, and groups everything by session. It does **not**
  know anything about HTTP, chunking, or retries.
- **The framework transports.** It takes the parsed work, slices it into request-sized chunks,
  sends each chunk, and advances the checkpoint — but only when the server accepts it. It does
  **not** know anything about Claude's file layout, cursors, or how a line fans out.

Adding a new agent later is a new plugin with its own parse logic and **zero framework edits**.

---

## The two halves

### 1. Plugin: `collect`

The framework calls `collect` **once per cycle**. The plugin does four things and returns the work
grouped by session (main file first, subagent files after):

1. **Discover** — glob its patterns to list all candidate files.
2. **Detect changes** — `stat` each candidate and compare `(mtime, size)` against that file's stored
   checkpoint. A file is unchanged if **both** match its checkpoint → skip it (no read, no parse).
   A file with no checkpoint is new (read from line 0); a file whose `mtime` **or** `size` differs
   has grown (read from its `lineProcessed` watermark). This `stat` gate is the whole reason the
   daemon is cheap: one syscall per file instead of re-reading every transcript every 10s.
3. **Read + parse** — for each changed file, read the new lines past the checkpoint and fan them out
   into `ParsedRecord`s (resolving the project, stamping per-message git facts).
4. **Group** — bucket the parsed tracks by session, main track first.

A session with no growth this cycle yields no `SessionBatch`; a session where only a subagent grew
yields a `SessionBatch` with just that track.

Change detection lives here (in the plugin), not in the framework, because it is tied to the
plugin's own checkpoint shape — Claude compares `mtime`/`size`, but another plugin might detect
change by content hash or a database cursor. The framework never stats files.

```ts
interface AgentPlugin {
  readonly source: string
  collect(prev: CheckpointStore, deps: CollectDeps): Promise<ReadonlyArray<SessionBatch>>
}

type CollectDeps = {
  readonly fs: FileSystem
  readonly glob: (pattern: string) => Promise<ReadonlyArray<string>>
  readonly resolveProject: (startDir: string) => Promise<ProjectIdentity>
}

type SessionBatch = {
  readonly sessionId: string
  readonly tracks: ReadonlyArray<SessionTrack>   // main agent first, then subagents (workflow, later)
}
```

A session has one or more **tracks** — one per participant. Today that's the main agent and its
subagents; later a session will also carry workflow-orchestration tracks. A **`SessionTrack`** is
one participant's freshly-parsed, not-yet-sent work — it's shaped exactly like an `IngestPayload`
(see [The ingest payload](#the-ingest-payload)) plus the two things the transport layer needs to
sync it:

```ts
type SessionTrack = IngestPayload & {
  readonly checkpointKey: string        // the transcript file path — how this track's checkpoint is keyed
  readonly records: ReadonlyArray<ParsedRecord>   // ALL new parsed lines, unsliced (overrides the per-chunk records)

  // Given "we successfully sent through source line N", return this plugin's checkpoint body
  // for that position. Pure — no I/O, no mutation. The framework calls it only after a 2xx.
  readonly checkpointAt: (lineNumber: number) => CheckpointBody
}
```

A track *is* a payload before chunking: it carries the identity (`type`, `sessionId`, `project`,
`sourceRelativePath`, `title?`, `agent`) plus **all** its new records, and the two transport-only
fields (`checkpointKey`, `checkpointAt`). The framework slices the records and emits one
`IngestPayload` per chunk — spreading the track's payload fields with the chunk's records and
dropping the two transport-only fields. There is no separate "envelope" type; the track already
carries the payload.

Two things to notice:

- **The plugin returns all new records unsliced.** Chunking is the framework's job (it's a
  request-size concern, not a parse fact). The plugin just parses everything new and hands it over.
- **The plugin knows how to advance its own checkpoint, but not when.** `checkpointAt` is a pure
  function: "if we got through line N, here's my new checkpoint body." The framework decides *when*
  to call it (only on a successful send). This is how the framework advances a Claude checkpoint
  without ever knowing what `lineProcessed` means.

### 2. Framework: `runCycle`

```
runCycle:
  prev = readCheckpoints()                          # CheckpointStore
  batches = plugin.collect(prev, deps)              # SessionBatch[]

  # Sessions are independent → run them in parallel. Each returns its own checkpoint updates.
  results = await Promise.all(batches.map(syncSession))

  # Each session only touched its own tracks, so the maps never collide.
  next = merge(prev, ...results)
  writeCheckpoints(next)                             # persist once, atomically


syncSession(batch):                                 # tracks are SEQUENTIAL, main agent first
  updated = {}                                      # checkpoints produced this cycle, keyed by track
  for track in batch.tracks:
      if not track.sessionId:                       # can't attribute it yet → skip, retry next cycle
          continue
      for chunk in sliceByMessages(track.records, MESSAGE_CAP):   # chunks SEQUENTIAL, in order
          status = await sink.send({ ...track, records: chunk.records })
          if status is 2xx:
              body = track.checkpointAt(chunk.lastCompleteLine)   # advance only past fully-sent lines
              updated[track.checkpointKey] = wrap(track, body)   # advance — success only
              log.debug({ sessionId, key: track.checkpointKey, status }, "flush ok")
          else:
              log.warn({ sessionId, key: track.checkpointKey, status }, "flush failed")
              return updated                        # stop this session; don't advance the rest
  return updated
```

`{ ...track, records: chunk.records }` builds a full `IngestPayload` by swapping the track's full
record set for just this chunk's records. `wrap(track, body)` assembles the full `Checkpoint` (see
[Checkpoints](#checkpoints)) from the plugin's body plus the framework-owned base.

---

## Ordering and failure, precisely

Three levels of nesting, each with its own rule:

```
sessions             ─ independent           → run in PARALLEL
  tracks (main first) ─ within a session      → SEQUENTIAL (a subagent 409s if its session isn't created yet)
    chunks (in order) ─ within a track        → SEQUENTIAL (chunk 2 resumes where chunk 1 left off)
```

- **A chunk is the unit of commit.** The checkpoint advances only after the server returns 2xx for
  that chunk. A crash, a 409, or any error leaves the checkpoint untouched, so next cycle re-reads
  from the same spot and retries. Advancing only on success is the entire safety story.
- **A session is the unit of failure isolation.** On the first non-2xx, we stop that session's
  remaining tracks and chunks for this cycle. Everything already sent stays committed; the rest
  retries next cycle. Because sessions run in parallel and touch disjoint tracks, one session
  failing never affects another.
- **A cycle is the unit of persistence.** Each session returns its own checkpoint map; the maps are
  key-disjoint (each session only touches its own tracks), so they merge with no conflict, and the
  store is written exactly once per cycle — atomically (temp file + rename), so a crash mid-write
  can't corrupt it.

**Errors are not stored in the checkpoint.** A checkpoint records only where we successfully got
to. A failed attempt isn't a new success, so it simply doesn't write a checkpoint — the retry falls
out of the unchanged checkpoint, not from any recorded error state. Retry counts and error messages
are observability, not correctness: they go to the injected pino `log` (already wired through the
watcher as `deps.log`) at the two marked points — a success line on each 2xx flush and a warn/error
line on each non-2xx — never into the checkpoint.

### Slicing (`sliceByMessages`)

The framework slices a track's records into chunks of at most `MESSAGE_CAP` (e.g. 2000)
**messages** — counting the fanned-out messages, not source lines. This bounds the request size by
the thing that actually varies (one line can fan out into many messages), and avoids the
pathological case of a single high-fan-out line becoming one enormous unsplittable request.

A record may straddle a chunk boundary — its messages split across two chunks. That's fine: both
chunks carry the same `lineUuid` and `raw` (harmless, the server dedups on `(lineUuid, subIndex)`),
each with its own subset of messages.

**Checkpoint advances only to the last *fully-sent* line.** The Claude checkpoint is a
`lineProcessed` watermark, so after a chunk that ends mid-line, the framework advances only to the
last line whose entire fan-out was in that chunk (via `checkpointAt(lastCompleteLine)`). The
partially-sent line is re-read and re-sent next chunk; the server dedups the messages it already
has. This keeps resume correct even though slicing is by message count.

---

## Checkpoints

The old design used a `FileState` shaped around "a file with a line watermark" — but that's a
*Claude* fact, not a framework fact. A future plugin might checkpoint by content hash, a database
cursor, or a timestamp. So the framework owns only a small, shared base, and each plugin defines
its own body:

```ts
// Framework-owned base — present on every checkpoint regardless of plugin.
// `source` is the discriminant.
type CheckpointBase = {
  readonly filePath: string        // the sync unit's key
  readonly lastUpdatedAt: string   // ISO; the framework stamps this on every successful advance
}

// Each plugin contributes one arm, discriminated on `source`:
type ClaudeCheckpoint = CheckpointBase & {
  readonly source: "claude_code"
  readonly mtime: number
  readonly size: number
  readonly lineProcessed: number
}
// future: type WorkflowCheckpoint = CheckpointBase & { source: "workflow"; ... }

type Checkpoint = ClaudeCheckpoint   // | WorkflowCheckpoint | …  (discriminated union on `source`)
type CheckpointStore = { readonly checkpoints: Record<string, Checkpoint> }   // keyed by filePath

// What checkpointAt returns — the plugin's arm minus the framework-owned base fields:
type CheckpointBody = Omit<ClaudeCheckpoint, keyof CheckpointBase>   // { source: "claude_code"; mtime; size; lineProcessed }
```

**Who owns what:**

- The **plugin** fills the body — for Claude, `checkpointAt(lineNumber)` returns
  `{ mtime, size, lineProcessed }` from the file stat it already read.
- The **framework** owns the two base fields it can supply generically: `filePath` (the track's
  `checkpointKey`) and `lastUpdatedAt` (from its clock). It stamps those around the plugin's body.
  `source` comes from the body (the plugin knows its own source — it's the discriminant). The
  framework never reads or interprets the body's other fields — it just stores the checkpoint and
  hands it back to the plugin (as `prev`) next cycle.

This is why `collect` receives `CheckpointStore` and `checkpointAt` returns only a body: the plugin
reads and writes its own body shape; the framework manages the base and the persistence.

---

## The ingest payload

The wire payload also gets a cleanup here. Today it carries two parallel arrays joined by
`lineUuid`:

```ts
// current (implemented): server joins rawLines ↔ messages by lineUuid
IngestBase = { sessionId, sourceRelativePath, project, rawLines: RawLine[], messages: NormalizedMessage[] }
```

Instead, group each source line with its own fan-out into one **`ParsedRecord`**. The `lineUuid` and
`lineNumber` live once on the record; the server-side `lineUuid` join disappears; and each record
carries its own `raw` shared by its messages.

```ts
type ProjectIdentity = { readonly name: string; readonly slug: string }   // server derives ownerId from the JWT

type ParsedRecord = {
  readonly lineUuid: string
  readonly lineNumber: number                          // this source line's number (drives slicing + checkpoint math)
  readonly raw: string                                 // the redacted source line
  readonly messages: ReadonlyArray<NormalizedMessage>  // this line's fan-out (0..N); message keeps subIndex, drops lineUuid + lineNumber
}

type AgentInfo = {
  readonly agentId: string
  readonly agentType?: string
  readonly description?: string
  readonly spawnDepth?: number
  readonly spawnToolUseId?: string
}

// Shared fields on every flush; `sourceRelativePath` + `title?` are flat on the base
// (title is main-only in practice, always absent on subagent flushes).
type IngestBase = {
  readonly sessionId: string
  readonly project: ProjectIdentity
  readonly sourceRelativePath: string             // this track's transcript file
  readonly title?: string                         // session title; empty/absent for now, enriched later
  readonly records: ReadonlyArray<ParsedRecord>   // replaces rawLines + messages
}

type IngestPayload =
  | (IngestBase & { readonly type: "main" })                                // nothing extra
  | (IngestBase & { readonly type: "subagent"; readonly agent: AgentInfo }) // + agent block
```

What changed from the current implemented contract:

- **`rawLines` + `messages` → `records`.** No more `lineUuid` join on the server; a record's `raw`
  is shared by its messages. `NormalizedMessage` drops the line-level fields now on the record
  (`lineUuid`, `lineNumber`) and keeps `subIndex`; the server rebuilds the `UNIQUE(lineUuid,
  subIndex)` key from `record.lineUuid + message.subIndex`, and stamps `record.lineNumber` onto each
  of the record's message rows.
- **`sourceRelativePath` and `title?` are flat on `IngestBase`.** There is no `SessionFields` block
  anymore — it had shrunk to exactly these two, so they moved onto the base. The `main`/`subagent`
  union now differs only by the `subagent`'s extra `agent` block.
- **`project { name, slug }` replaces `repo`** — from [projects-first-class](../projects-first-class/design.md);
  the server derives `ownerId` from the JWT.
- **Dropped from the session/wire:** `cwd` (only fed client-side `resolveProject`), `permissionMode`,
  `cliVersion`. `model` is already a per-message field. `gitBranch`/`gitCommit` are per-message
  (they vary line-to-line — projects-first-class P6).

There is **no separate envelope type.** A `SessionTrack` already *is* an `IngestPayload` (carrying
all its records); the framework sends each chunk as `{ ...track, records: chunk.records }`. The
plugin resolves the project (via `resolveProject`) and stamps `gitBranch`/`gitCommit` onto each
message during parse, so the framework never resolves identity or touches git facts itself.

---

## Worked example

**5 transcript files, ~4000 new messages each, `MESSAGE_CAP = 2000`** → each track is ~2 chunks →
~10 requests.

- **If they're 5 separate sessions:** all 5 run in parallel. Each sends chunk 1 (~first 2000
  messages), then on 2xx chunk 2. If session 3's chunk 1 fails, session 3 stops (chunk 2 not sent,
  its checkpoint unchanged) and the other four finish untouched. Next cycle, session 3 retries from
  its unchanged checkpoint.
- **If they're 1 session** (1 main + 4 subagents): one `SessionBatch`, tracks ordered
  `[main, sub, sub, sub, sub]`, processed sequentially. Main's chunks go first; only once they land
  do the subagents flush (so they can't 409 on a missing session). If subagent #2 fails, the session
  stops there — main and subagent #1 stay committed; #2, #3, #4 retry next cycle.

---

## What changes in the code

**Plugin side (`packages/core/src/collector`)**

- `AgentPlugin.collect(changed, prev)` (per-file) → `collect(prev, deps)` (once per cycle, returns
  `SessionBatch[]`). The `globs` field leaves the interface — the plugin discovers its own files.
- The Claude plugin owns: discovery, the `stat`-based change gate (compare `(mtime, size)` vs the
  checkpoint, skip unchanged files), `readNewLines`, fan-out parse, `resolveProject`, grouping by
  session into tracks (main-first), and `checkpointAt`.
- `FileState` → `Checkpoint` (discriminated union on `source`); the state file becomes a
  `CheckpointStore`.

**Framework side (`packages/cli/src/watcher/driver.ts`)**

- Remove `orderMainFirst`, the subagent-path regex, `changedFileFor`, the per-file `flushFile` loop,
  `capMessages`, and `repoFor`/`resolveProject`-in-the-loop.
- `runCycle` becomes: `collect` → parallel `syncSession` → merge disjoint checkpoint maps → persist
  once. `syncSession` walks a session's tracks sequentially, slices each with `sliceByMessages`,
  sends chunks, advances on 2xx (to the last fully-sent line), stops the session on failure.

**Server side**

- Ingest route/service adopt `records` (drop the `lineUuid` join), read `sourceRelativePath` +
  `title` from the base, and take per-message `gitBranch`/`gitCommit`. (The projects-side envelope
  changes are already implemented; this is the `records` + flattened-base restructure on top.)

**Logging**

- pino logging is already wired (`deps.log` in the watcher, `createLogger` in core). `syncSession`
  logs a success line on each 2xx flush and a warn/error line on each non-2xx (with `sessionId`,
  `checkpointKey`, status). Nothing about errors or retry counts is stored in the checkpoint.

---

## Open questions

1. **`MESSAGE_CAP` value + request size.** The cap is a message count (e.g. 2000). A record may
   split across chunks (both chunks carry the same `lineUuid`/`raw`; the server dedups). Confirm the
   number, and whether a secondary byte guard is worth adding if per-message payloads get large.
2. **Checkpoint at a mid-line boundary.** When a chunk ends mid-line, the checkpoint advances only
   to the last fully-sent line (`checkpointAt(lastCompleteLine)`); the straddling line is re-sent
   next chunk and deduped. Confirm this is acceptable vs. always cutting chunks on line boundaries
   (which would reintroduce the "one huge line = one huge chunk" problem message-slicing avoids).
3. **Stop-the-session vs. continue-past-a-subagent-failure.** We stop the whole session on the
   first failure. This is strictly right for a *main*-track failure (subagents mustn't flush without
   a session), but conservative for a *subagent*-track failure (a transient error on subagent #2
   needlessly defers #3, #4 to next cycle). Loosen to "stop only on main-track failure" later if
   subagent throughput matters.
4. **`resolveProject` failure.** It always yields a deterministic slug (git remote, else the cwd
   path), so it's never network-blocked. The only real failure is an unknown starting dir
   (projects-first-class OQ-c) — then emit no track for that file and retry next cycle.
