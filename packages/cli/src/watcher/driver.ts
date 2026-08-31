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
import { mapWithLimit } from "../concurrency.js"
import { persistedApiUrl } from "../config/server-scope.js"
import { collectArtifacts } from "./artifact-extract.js"
import { type ArtifactQueueEntry, enqueue } from "./artifact-queue.js"
import { shouldCaptureArtifacts } from "./containment.js"
import { collectGitEvents } from "./gitEvents.js"
import { createRepoResolver, resolveHeadSha } from "./resolveRepo.js"
import type { SinkResult } from "./sink.js"

export type Clock = { now(): number }

export type WatcherConfig = {
  readonly statePath: string
  /** Absent means the cycle does no artifact work at all. */
  readonly artifactQueuePath?: string
  /** Both resolved once at startup by `parseConfig`, so a cycle never re-reads the environment. */
  readonly messageCap: number
  readonly sessionConcurrency: number
}

export type WatcherDeps = {
  readonly fs: FileSystem
  readonly clock: Clock
  readonly sink: { send(payload: IngestPayload): Promise<SinkResult> }
  readonly glob: (pattern: string) => Promise<ReadonlyArray<string>>
  /**
   * Every registered plugin runs each cycle. The watcher was written for one plugin at a time
   * (Claude Code), and the second source adapter arrives through the registry so the cycle
   * iterates and merges all their batches. Checkpoints are per plugin via the source-aware
   * `track.checkpointKey`.
   */
  readonly plugins: ReadonlyArray<AgentPlugin>
  readonly resolveProject: (startDir: string) => Promise<ProjectIdentity | null>
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
  let current: ParsedRecord[] = []
  let count = 0

  for (const record of records) {
    const recordCount = record.messages.length
    if (current.length > 0 && count + recordCount > cap) {
      chunks.push(chunk(current))
      current = []
      count = 0
    }
    current.push(record)
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

/**
 * A bare "flush failed" tells nobody what to do about it, so every status the server can answer
 * with is turned into the sentence a person reading the log needs.
 */
export const flushCause = (status: number): string => {
  if (status === 0) return "the server could not be reached; the chunk retries next cycle"
  if (status === 401)
    return "the server rejected this CLI's credentials -- run `samskara login` to pair again"
  if (status === 403)
    return "the server no longer lets this CLI write to that project -- run `samskara reassign` in that folder to point it at one you can write"
  if (status === 409) return "the server has no session to attach these records to yet"
  if (status === 413) return "the chunk was larger than the server accepts"
  if (status === 429) return "the server is rate limiting this CLI; the chunk retries next cycle"
  if (status >= 500) return "the server errored; the chunk retries next cycle"
  return "the server rejected the upload"
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
  messageCap: number,
): Promise<Checkpoint | undefined> => {
  const records = await attributeRepos(track.records, track.project.root)
  // Collected once over the whole track, then attached to the chunk holding each event's
  // *result*: the call may sit in an earlier chunk, already persisted by the time the event
  // arrives, and the server resolves the callId from its stored rows.
  const events = collectGitEvents(records, deps.log)
  let sentThrough = 0
  let okChunks = 0
  let messagesSent = 0
  let stoppedOnFailure = false
  const reqIds: string[] = []
  for (const request of sliceByMessages(records, messageCap)) {
    const resultIds = new Set(
      request.records
        .flatMap((record) => record.messages)
        .flatMap((message) => (message.msgType === "toolResult" ? [message.details.callId] : [])),
    )
    const chunkEvents = events.filter((event) => resultIds.has(event.callId))
    const { status, detail, reqId } = await deps.sink.send(
      payloadFor(track, request.records, origin, chunkEvents),
    )
    if (status < 200 || status >= 300) {
      stoppedOnFailure = true
      deps.log.warn(
        {
          sessionId: track.sessionId,
          key: track.checkpointKey,
          status,
          ...(detail ? { detail } : {}),
          ...(reqId ? { reqId } : {}),
        },
        `flush failed: ${flushCause(status)}`,
      )
      break
    }
    sentThrough = request.lastCompleteLine
    okChunks += 1
    messagesSent += request.records.reduce((total, record) => total + record.messages.length, 0)
    if (reqId) reqIds.push(reqId)
    deps.log.debug(
      { sessionId: track.sessionId, key: track.checkpointKey, status, ...(reqId ? { reqId } : {}) },
      "flush ok",
    )
  }
  if (sentThrough === 0) return undefined
  const summary = {
    sessionId: track.sessionId,
    key: track.checkpointKey,
    repo: track.project.slug,
    chunks: okChunks,
    messages: messagesSent,
    reqIds,
  }
  if (stoppedOnFailure) {
    deps.log.warn(summary, "session partially synced; the remaining chunks retry next cycle")
  } else {
    deps.log.info(summary, "session synced")
  }
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
  messageCap: number,
): Promise<Record<string, Checkpoint>> => {
  const updated: Record<string, Checkpoint> = {}
  for (const track of batch.tracks) {
    const checkpoint = await syncTrack(track, await originFor(track, prev), deps, messageCap)
    if (checkpoint) updated[track.checkpointKey] = checkpoint
  }
  return updated
}

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
  const artifacts = collectArtifacts(
    batch.tracks.flatMap((track) => track.records),
    root,
  )
  const decisions = await shouldCaptureArtifacts(
    artifacts.map((artifact) => artifact.path),
    { projectRoot: root, allowScratch: true },
  )

  const entries = artifacts.flatMap((artifact, index): ArtifactQueueEntry[] => {
    const decision = decisions[index]
    if (!decision?.ok) {
      deps.log.debug(
        { path: artifact.path, reason: decision?.reason },
        "artifact candidate skipped",
      )
      return []
    }
    return [
      {
        sessionId: batch.sessionId,
        path: decision.path,
        relativePath: decision.relativePath,
        projectRoot: root,
        created: artifact.created,
        ...(artifact.base === undefined ? {} : { base: artifact.base }),
        observedAt,
        attempts: 0,
      },
    ]
  })

  if (entries.length > 0) await enqueue(queuePath, entries, deps.log)

  if (artifacts.length > 0) {
    deps.log.info(
      {
        root,
        found: artifacts.length,
        skipped: artifacts.length - entries.length,
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
  // The cycle writes the store back at the end, so the file repairs itself; what it cannot do is
  // tell anyone that every session is about to be sent again from its first line.
  const prev: CheckpointStore = await readCheckpoints(deps.fs, config.statePath).catch(
    (err: unknown) => {
      deps.log.error(
        { path: config.statePath, err },
        "checkpoint store did not parse; every session resyncs from the start",
      )
      return { checkpoints: {} }
    },
  )
  // Every directory identity resolved from disk this cycle, merged into the store below. Once a
  // cwd is gone -- a removed worktree -- it is the only way its sessions stay attributable.
  const resolved = new Map<string, ProjectIdentity>()
  const collectDeps: CollectDeps = {
    fs: deps.fs,
    glob: deps.glob,
    resolveProject: deps.resolveProject,
    rememberProject: (dir, project) => {
      resolved.set(dir, project)
    },
    log: deps.log,
    ...(deps.shouldCapture ? { shouldCapture: deps.shouldCapture } : {}),
    ...(deps.syncFromFor ? { syncFromFor: deps.syncFromFor } : {}),
  }
  const batchLists = await Promise.all(
    deps.plugins.map((plugin) => plugin.collect(prev, collectDeps)),
  )
  const batches = batchLists.flat()
  const results = await mapWithLimit(batches, config.sessionConcurrency, (batch) =>
    syncSession(batch, prev, deps, config.messageCap),
  )

  // After the flush, before the checkpoint write: enqueuing earlier would queue artifacts for
  // records that never reached the server, and the worker would 409 on every one.
  const { artifactQueuePath } = config
  if (artifactQueuePath !== undefined) {
    for (const batch of batches) {
      const root = batch.tracks[0]?.project.root
      // `root` is optional on the identity, and artifact capture is meaningless without one.
      if (root === undefined) continue
      await enqueueArtifacts(batch, root, artifactQueuePath, deps)
    }
  }

  const checkpoints = Object.assign({}, prev.checkpoints, ...results)
  const projects = { ...prev.projects, ...Object.fromEntries(resolved) }
  const next: CheckpointStore = {
    checkpoints,
    apiBase: persistedApiUrl(),
    ...(Object.keys(projects).length > 0 ? { projects } : {}),
  }
  await writeCheckpoints(deps.fs, config.statePath, next)
  return next
}
