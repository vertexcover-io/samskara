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

export type WatcherConfig = {
  readonly statePath: string
}

export type WatcherDeps = {
  readonly fs: FileSystem
  readonly clock: Clock
  readonly sink: { send(payload: IngestPayload): Promise<{ status: number }> }
  readonly glob: (pattern: string) => Promise<ReadonlyArray<string>>
  readonly plugin: AgentPlugin
  readonly resolveProject: (startDir: string) => Promise<ProjectIdentity>
  readonly shouldCapture?: (project: ProjectIdentity) => Promise<boolean>
  readonly log: pino.Logger
}

export type Chunk = {
  readonly records: ReadonlyArray<ParsedRecord>
  readonly lastCompleteLine: number
}

const messageCount = (record: ParsedRecord): number => record.messages.length

// Slice a track's records into chunks of at most `cap` fanned-out messages, in order.
// A record may straddle a boundary — both chunks carry the same lineUuid/raw with disjoint
// message subsets. `lastCompleteLine` is the last line whose entire fan-out fit in that chunk.
export const sliceByMessages = (
  records: ReadonlyArray<ParsedRecord>,
  cap: number,
): ReadonlyArray<Chunk> => {
  const chunks: Chunk[] = []
  let current: ParsedRecord[] = []
  let count = 0
  let lastComplete = 0

  const flush = () => {
    if (current.length === 0) return
    chunks.push({ records: current, lastCompleteLine: lastComplete })
    current = []
    count = 0
  }

  for (const record of records) {
    const n = messageCount(record)

    // A record with no messages still carries its line — attach it and mark it complete.
    if (n === 0) {
      current.push(record)
      lastComplete = record.lineNumber
      continue
    }

    let offset = 0
    while (offset < n) {
      if (count === cap) flush()
      const room = cap - count
      const slice = record.messages.slice(offset, offset + room)
      current.push({ ...record, messages: slice })
      count += slice.length
      offset += slice.length
      // The line is complete only once its final messages are in this chunk.
      if (offset === n) lastComplete = record.lineNumber
    }
  }
  flush()

  return chunks
}

const wrap = (track: SessionTrack, base: Clock, body: CheckpointBody): Checkpoint => ({
  ...body,
  filePath: track.checkpointKey,
  lastUpdatedAt: new Date(base.now()).toISOString(),
  projectSlug: track.project.slug,
})

const payloadFor = (track: SessionTrack, records: ReadonlyArray<ParsedRecord>): IngestPayload => {
  const { checkpointKey: _key, checkpointAt: _at, records: _all, ...payload } = track
  return { ...payload, records }
}

const lineProcessedOf = (prev: CheckpointStore, key: string): number =>
  prev.checkpoints[key]?.lineProcessed ?? 0

const syncSession = async (
  batch: SessionBatch,
  prev: CheckpointStore,
  deps: WatcherDeps,
): Promise<Record<string, Checkpoint>> => {
  const updated: Record<string, Checkpoint> = {}
  const { sessionId } = batch

  for (const track of batch.tracks) {
    if (!track.sessionId) continue

    for (const chunk of sliceByMessages(track.records, MESSAGE_CAP)) {
      const { status } = await deps.sink.send(payloadFor(track, chunk.records))
      if (status < 200 || status >= 300) {
        deps.log.warn({ sessionId, key: track.checkpointKey, status }, "flush failed")
        return updated
      }
      deps.log.debug({ sessionId, key: track.checkpointKey, status }, "flush ok")

      // Advance only when this chunk fully sent a new line past our watermark. A chunk that ends
      // mid-line (lastCompleteLine not beyond the prior mark) records nothing, so its unchanged
      // mtime/size can't make the plugin skip the file before those lines are re-sent.
      const alreadyAt = lineProcessedOf(prev, track.checkpointKey)
      const currentAt = updated[track.checkpointKey]?.lineProcessed ?? alreadyAt
      if (chunk.lastCompleteLine > currentAt) {
        updated[track.checkpointKey] = wrap(
          track,
          deps.clock,
          track.checkpointAt(chunk.lastCompleteLine),
        )
      }
    }
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
    ...(deps.shouldCapture ? { shouldCapture: deps.shouldCapture } : {}),
  }
  const batches = await deps.plugin.collect(prev, collectDeps)

  const results = await Promise.all(
    batches
      .filter((batch) => batch.tracks.length > 0)
      .map((batch) => syncSession(batch, prev, deps)),
  )

  // Sessions touch disjoint tracks, so the maps never collide.
  const checkpoints = { ...prev.checkpoints }
  for (const map of results) Object.assign(checkpoints, map)

  const next: CheckpointStore = { checkpoints }
  await writeCheckpoints(deps.fs, config.statePath, next)
  return next
}
