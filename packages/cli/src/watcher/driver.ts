import type {
  AgentPlugin,
  Checkpoint,
  CheckpointBody,
  CheckpointStore,
  CollectDeps,
  FileSystem,
  IngestPayload,
  IngestSessionTrack,
  LineOutcome,
  ParsedRecord,
  ProjectIdentity,
  SessionBatch,
  SessionTrack,
} from "@samskara/core"
import { readCheckpoints, writeCheckpoints } from "@samskara/core"
import type pino from "pino"

export const MESSAGE_CAP = 2000

export type Clock = { now(): number }
export type WatcherConfig = { readonly statePath: string }
export type WatcherDeps = {
  readonly fs: FileSystem
  readonly clock: Clock
  readonly sink: { send(payload: IngestPayload): Promise<{ status: number }> }
  readonly glob: (pattern: string) => Promise<ReadonlyArray<string>>
  readonly plugin: AgentPlugin
  readonly resolveProject: (startDir: string) => Promise<ProjectIdentity>
  readonly log: pino.Logger
}

export type Chunk = {
  readonly records: ReadonlyArray<ParsedRecord>
  readonly lastCompleteLine: number
}

const chunk = (records: ReadonlyArray<ParsedRecord>): Chunk => ({
  records,
  lastCompleteLine: records.at(-1)?.lineNumber ?? 0,
})

export const sliceByMessages = (
  records: ReadonlyArray<ParsedRecord>,
  cap: number,
): ReadonlyArray<Chunk> => {
  const chunks: Chunk[] = []
  let current: ReadonlyArray<ParsedRecord> = []
  let count = 0

  const flush = () => {
    if (current.length === 0) return
    chunks.push(chunk(current))
    current = []
    count = 0
  }

  for (const record of records) {
    const recordCount = record.messages.length
    if (current.length > 0 && count + recordCount > cap) flush()
    current = [...current, record]
    count += recordCount
    if (count >= cap) flush()
  }
  flush()
  return chunks
}

const wrap = (track: SessionTrack, clock: Clock, body: CheckpointBody): Checkpoint => ({
  ...body,
  filePath: track.checkpointKey,
  lastUpdatedAt: new Date(clock.now()).toISOString(),
})

const payloadFor = (
  track: IngestSessionTrack,
  records: ReadonlyArray<ParsedRecord>,
): IngestPayload => {
  const {
    kind: _kind,
    checkpointKey: _key,
    checkpointAt: _at,
    outcomes: _outcomes,
    records: _all,
    ...payload
  } = track
  return { ...payload, records }
}

const lineProcessedOf = (prev: CheckpointStore, key: string): number =>
  prev.checkpoints[key]?.lineProcessed ?? 0

const contiguousLine = (
  outcomes: ReadonlyArray<LineOutcome>,
  acceptedLines: ReadonlySet<number>,
  initialLine: number,
): number => {
  let line = initialLine
  for (const outcome of outcomes) {
    if (outcome.lineNumber <= initialLine) continue
    if (outcome.lineNumber !== line + 1) break
    if (outcome.kind === "blocked") break
    if (outcome.kind === "record" && !acceptedLines.has(outcome.lineNumber)) break
    line = outcome.lineNumber
  }
  return line
}

const checkpointFor = (
  track: SessionTrack,
  prev: CheckpointStore,
  acceptedLines: ReadonlySet<number>,
  clock: Clock,
): Checkpoint | undefined => {
  const initialLine = lineProcessedOf(prev, track.checkpointKey)
  const line = contiguousLine(track.outcomes, acceptedLines, initialLine)
  return line > initialLine ? wrap(track, clock, track.checkpointAt(line)) : undefined
}

const syncTrack = async (
  track: SessionTrack,
  prev: CheckpointStore,
  deps: WatcherDeps,
): Promise<Checkpoint | undefined> => {
  const acceptedLines = new Set<number>()
  if (track.kind === "checkpointOnly") {
    return checkpointFor(track, prev, acceptedLines, deps.clock)
  }

  let latest = checkpointFor(track, prev, acceptedLines, deps.clock)
  for (const request of sliceByMessages(track.records, MESSAGE_CAP)) {
    const { status } = await deps.sink.send(payloadFor(track, request.records))
    if (status < 200 || status >= 300) {
      deps.log.warn(
        { sessionId: track.sessionId, key: track.checkpointKey, status },
        "flush failed",
      )
      return latest
    }
    for (const record of request.records) acceptedLines.add(record.lineNumber)
    latest = checkpointFor(track, prev, acceptedLines, deps.clock) ?? latest
    deps.log.debug({ sessionId: track.sessionId, key: track.checkpointKey, status }, "flush ok")
  }
  return latest
}

const syncSession = async (
  batch: SessionBatch,
  prev: CheckpointStore,
  deps: WatcherDeps,
): Promise<Record<string, Checkpoint>> => {
  const updated: Record<string, Checkpoint> = {}
  for (const track of batch.tracks) {
    const checkpoint = await syncTrack(track, prev, deps)
    if (checkpoint) updated[track.checkpointKey] = checkpoint
  }
  return updated
}

export const runCycle = async (
  config: WatcherConfig,
  deps: WatcherDeps,
): Promise<CheckpointStore> => {
  const prev = await readCheckpoints(deps.fs, config.statePath)
  const collectDeps: CollectDeps = {
    fs: deps.fs,
    glob: deps.glob,
    resolveProject: deps.resolveProject,
    log: deps.log,
  }
  const batches = await deps.plugin.collect(prev, collectDeps)
  const results = await Promise.all(batches.map((batch) => syncSession(batch, prev, deps)))
  const checkpoints = Object.assign({}, prev.checkpoints, ...results)
  const next: CheckpointStore = { checkpoints }
  await writeCheckpoints(deps.fs, config.statePath, next)
  return next
}
