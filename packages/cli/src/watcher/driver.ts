import type {
  AgentPlugin,
  Checkpoint,
  CheckpointBody,
  CheckpointStore,
  CollectDeps,
  FileSystem,
  IngestPayload,
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
  readonly shouldCapture?: (project: ProjectIdentity) => Promise<boolean>
  readonly syncFromFor?: (project: ProjectIdentity) => Promise<string | undefined>
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

  for (const record of records) {
    const recordCount = record.messages.length
    if (current.length > 0 && count + recordCount > cap) {
      chunks.push(chunk(current))
      current = []
      count = 0
    }
    current = [...current, record]
    count += recordCount
    if (count >= cap) {
      chunks.push(chunk(current))
      current = []
      count = 0
    }
  }
  if (current.length > 0) chunks.push(chunk(current))
  return chunks
}

const wrap = (track: SessionTrack, clock: Clock, body: CheckpointBody): Checkpoint => ({
  ...body,
  filePath: track.checkpointKey,
  projectSlug: track.project.slug,
  lastUpdatedAt: new Date(clock.now()).toISOString(),
})

const payloadFor = (track: SessionTrack, records: ReadonlyArray<ParsedRecord>): IngestPayload => {
  const {
    checkpointKey: _key,
    checkpointAt: _at,
    lastLineProcessed: _last,
    records: _all,
    ...payload
  } = track
  return { ...payload, records }
}

const syncTrack = async (
  track: SessionTrack,
  deps: WatcherDeps,
): Promise<Checkpoint | undefined> => {
  let sentThrough = 0
  for (const request of sliceByMessages(track.records, MESSAGE_CAP)) {
    const { status } = await deps.sink.send(payloadFor(track, request.records))
    if (status < 200 || status >= 300) {
      deps.log.warn(
        { sessionId: track.sessionId, key: track.checkpointKey, status },
        "flush failed",
      )
      break
    }
    sentThrough = request.lastCompleteLine
    deps.log.debug({ sessionId: track.sessionId, key: track.checkpointKey, status }, "flush ok")
  }
  if (sentThrough === 0) return undefined
  const line =
    sentThrough === track.records.at(-1)?.lineNumber ? track.lastLineProcessed : sentThrough
  return wrap(track, deps.clock, track.checkpointAt(line))
}

const syncSession = async (
  batch: SessionBatch,
  deps: WatcherDeps,
): Promise<Record<string, Checkpoint>> => {
  const updated: Record<string, Checkpoint> = {}
  for (const track of batch.tracks) {
    const checkpoint = await syncTrack(track, deps)
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
    ...(deps.shouldCapture ? { shouldCapture: deps.shouldCapture } : {}),
    ...(deps.syncFromFor ? { syncFromFor: deps.syncFromFor } : {}),
  }
  const batches = await deps.plugin.collect(prev, collectDeps)
  const results = await Promise.all(batches.map((batch) => syncSession(batch, deps)))
  const checkpoints = Object.assign({}, prev.checkpoints, ...results)
  const next: CheckpointStore = { checkpoints }
  await writeCheckpoints(deps.fs, config.statePath, next)
  return next
}
