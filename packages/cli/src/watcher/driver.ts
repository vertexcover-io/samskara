import type {
  AgentPlugin,
  Checkpoint,
  CheckpointBody,
  CheckpointStore,
  CollectDeps,
  FileSystem,
  GitEvent,
  IngestPayload,
  ParsedRecord,
  ProjectIdentity,
  SessionBatch,
  SessionTrack,
} from "@samskara/core"
import { readCheckpoints, writeCheckpoints } from "@samskara/core"
import type pino from "pino"
import { type PotentialArtifact, collectArtifacts } from "./artifact-extract.js"
import { type ArtifactQueueEntry, enqueue } from "./artifact-queue.js"
import { shouldCaptureArtifacts } from "./containment.js"
import { collectGitEvents } from "./gitEvents.js"
import { createRepoResolver, resolveHeadSha } from "./resolveRepo.js"

export const MESSAGE_CAP = 2000

export type Clock = { now(): number }

export type WatcherConfig = {
  readonly statePath: string
  /** Absent means the cycle does no artifact work at all. */
  readonly artifactQueuePath?: string
}

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

const payloadFor = (
  track: SessionTrack,
  records: ReadonlyArray<ParsedRecord>,
  origin: SessionOrigin,
  gitEvents: ReadonlyArray<GitEvent>,
): IngestPayload => {
  const {
    checkpointKey: _key,
    checkpointAt: _at,
    lastLineProcessed: _last,
    records: _all,
    ...payload
  } = track
  const events = gitEvents.length === 0 ? {} : { gitEvents }
  if (payload.type === "subagent") return { ...payload, records, ...events }
  return { ...payload, records, ...origin, ...events }
}

// One resolver for the daemon's whole life, so its cwd cache outlives a cycle.
const resolveRepo = createRepoResolver()

/**
 * Attributes each message to the repo of the cwd it happened in — per message, not per track,
 * because a track's messages can span checkouts. A cwd that is not a git repo yields no
 * attribution, which is normal rather than an error.
 */
const attributeRepos = async (
  records: ReadonlyArray<ParsedRecord>,
  fallbackCwd: string | undefined,
): Promise<ReadonlyArray<ParsedRecord>> =>
  Promise.all(
    records.map(async (record) => {
      const messages = await Promise.all(
        record.messages.map(async (message) => {
          const cwd = message.cwd ?? fallbackCwd
          const resolved = cwd ? await resolveRepo(cwd) : null
          if (!resolved) return message
          const { root: _root, ...repo } = resolved
          return { ...message, repo }
        }),
      )
      const [first, ...rest] = messages
      if (!first) return record
      return { ...record, messages: [first, ...rest] as const }
    }),
  )

/** The launch context a main session is stamped with, captured once when it is first seen. */
type SessionOrigin = { readonly startCwd?: string; readonly startCommit?: string }

const syncTrack = async (
  track: SessionTrack,
  origin: SessionOrigin,
  deps: WatcherDeps,
): Promise<Checkpoint | undefined> => {
  const records = await attributeRepos(track.records, track.project.root)
  // Collected once over the whole track, then attached to the chunk holding each event's
  // *result*: the call may sit in an earlier chunk, already persisted by the time the event
  // arrives, and the server resolves the callId from its stored rows.
  const events = collectGitEvents(records, deps.log)
  let sentThrough = 0
  for (const request of sliceByMessages(records, MESSAGE_CAP)) {
    const resultIds = new Set(
      request.records
        .flatMap((record) => record.messages)
        .flatMap((message) => (message.msgType === "toolResult" ? [message.details.callId] : [])),
    )
    const chunkEvents = events.filter((event) => resultIds.has(event.callId))
    const { status } = await deps.sink.send(payloadFor(track, request.records, origin, chunkEvents))
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

/**
 * HEAD is read once, on the flush that first sends a session, and never again: the watcher polls
 * after the fact, so by a later cycle HEAD has moved to whatever the session has since committed.
 * A track already in the checkpoint store has been sent before, so its origin is already stored.
 */
const originFor = async (track: SessionTrack, prev: CheckpointStore): Promise<SessionOrigin> => {
  if (track.type !== "main") return {}
  if (prev.checkpoints[track.checkpointKey]) return {}
  const startCwd = track.records
    .flatMap((record) => record.messages)
    .find((message) => message.cwd !== undefined)?.cwd
  if (!startCwd) return {}
  const startCommit = await resolveHeadSha(startCwd)
  return { startCwd, ...(startCommit ? { startCommit } : {}) }
}

const syncSession = async (
  batch: SessionBatch,
  prev: CheckpointStore,
  deps: WatcherDeps,
): Promise<Record<string, Checkpoint>> => {
  const updated: Record<string, Checkpoint> = {}
  for (const track of batch.tracks) {
    const checkpoint = await syncTrack(track, await originFor(track, prev), deps)
    if (checkpoint) updated[track.checkpointKey] = checkpoint
  }
  return updated
}

type TrackedCandidate = {
  readonly sessionId: string
  readonly candidate: PotentialArtifact
}

const candidatesOf = (
  batch: SessionBatch,
  root: string,
  log: pino.Logger,
): ReadonlyArray<TrackedCandidate> =>
  batch.tracks.flatMap((track) =>
    collectArtifacts(track.records, track.project.root ?? root, log).map((candidate) => ({
      sessionId: track.sessionId,
      candidate,
    })),
  )

/**
 * A file already queued this run is queued again rather than remembered: the worker settles
 * duplicates on the content hash it already holds, so a second entry costs a queue write and
 * nothing more.
 */
const enqueueArtifacts = async (
  batch: SessionBatch,
  root: string,
  queuePath: string,
  deps: WatcherDeps,
): Promise<void> => {
  const observedAt = new Date(deps.clock.now()).toISOString()
  const candidates = candidatesOf(batch, root, deps.log)
  const decisions = await shouldCaptureArtifacts(
    candidates.map(({ candidate }) => candidate.path),
    { projectRoot: root, allowScratch: true },
  )

  const entries = candidates.flatMap(({ sessionId, candidate }, index): ArtifactQueueEntry[] => {
    const decision = decisions[index]
    if (!decision?.ok) {
      deps.log.debug(
        { path: candidate.path, reason: decision?.reason },
        "artifact candidate skipped",
      )
      return []
    }
    return [
      {
        sessionId,
        path: decision.path,
        relativePath: decision.relativePath,
        projectRoot: root,
        changeKind: candidate.changeKind,
        ...(candidate.backupFileName === undefined
          ? {}
          : { backupFileName: candidate.backupFileName }),
        ...(candidate.oldFragment === undefined ? {} : { oldFragment: candidate.oldFragment }),
        observedAt,
        attempts: 0,
      },
    ]
  })

  if (entries.length > 0) await enqueue(queuePath, entries, deps.log)

  if (candidates.length > 0) {
    deps.log.info(
      {
        root,
        found: candidates.length,
        skipped: candidates.length - entries.length,
        enqueued: entries.length,
      },
      "artifact candidates enqueued",
    )
  }
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
  const results = await Promise.all(batches.map((batch) => syncSession(batch, prev, deps)))

  // After the flush, before the checkpoint write: enqueuing earlier would queue artifacts for
  // records that never reached the server, and the worker would 409 on every one.
  const { artifactQueuePath } = config
  if (artifactQueuePath !== undefined) {
    for (const batch of batches) {
      const root = batch.tracks[0]?.project.root
      // No root means the --project-slug override path, which synthesizes an identity without
      // one. Silent by design: it recurs every cycle for the whole run.
      if (root === undefined) continue
      await enqueueArtifacts(batch, root, artifactQueuePath, deps)
    }
  }

  const checkpoints = Object.assign({}, prev.checkpoints, ...results)
  const next: CheckpointStore = { checkpoints }
  await writeCheckpoints(deps.fs, config.statePath, next)
  return next
}
