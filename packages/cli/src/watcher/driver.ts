import { relative } from "node:path"
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
import { atomicWriteJson, readJson } from "../config/atomic.js"
import { collectArtifacts } from "./artifact-extract.js"
import { type QueueEntry, enqueue } from "./artifact-queue.js"
import { isCapturable } from "./containment.js"
import type { ResolvedRepo } from "./resolveRepo.js"

export const MESSAGE_CAP = 2000

export type Clock = { now(): number }
export type WatcherConfig = { readonly statePath: string }

/**
 * The cycle's only disk contact with an artifact: `realpath` to judge a symlink by its target,
 * and `stat` to skip a file whose bytes have not moved since the last cycle. Absent, the cycle
 * does no artifact work at all.
 */
export type ArtifactCycleDeps = {
  readonly queuePath: string
  readonly statePath?: string
  readonly realpath: (path: string) => Promise<string>
  readonly stat: (path: string) => Promise<{ readonly size: number; readonly mtimeMs: number }>
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
  readonly artifacts?: ArtifactCycleDeps
  readonly resolveRepo?: (cwd: string) => Promise<ResolvedRepo | null>
  readonly resolveHead?: (cwd: string) => Promise<string | null>
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
): IngestPayload => {
  const {
    checkpointKey: _key,
    checkpointAt: _at,
    lastLineProcessed: _last,
    records: _all,
    ...payload
  } = track
  if (payload.type === "subagent") return { ...payload, records }
  return { ...payload, records, ...origin }
}

/**
 * Attributes each message to the repo of the cwd it happened in — per message, not per track,
 * because a track's messages can span checkouts. A cwd that is not a git repo yields no
 * attribution, which is normal rather than an error.
 */
const attributeRepos = async (
  records: ReadonlyArray<ParsedRecord>,
  fallbackCwd: string | undefined,
  resolveRepo: (cwd: string) => Promise<ResolvedRepo | null>,
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
  const { resolveRepo } = deps
  const records = resolveRepo
    ? await attributeRepos(track.records, track.project.root, resolveRepo)
    : track.records
  let sentThrough = 0
  for (const request of sliceByMessages(records, MESSAGE_CAP)) {
    const { status } = await deps.sink.send(payloadFor(track, request.records, origin))
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
const originFor = async (
  track: SessionTrack,
  prev: CheckpointStore,
  deps: WatcherDeps,
): Promise<SessionOrigin> => {
  if (track.type !== "main") return {}
  if (prev.checkpoints[track.checkpointKey]) return {}
  const startCwd = track.records
    .flatMap((record) => record.messages)
    .find((message) => message.cwd !== undefined)?.cwd
  if (!startCwd) return {}
  const startCommit = await deps.resolveHead?.(startCwd)
  return { startCwd, ...(startCommit ? { startCommit } : {}) }
}

const syncSession = async (
  batch: SessionBatch,
  prev: CheckpointStore,
  deps: WatcherDeps,
): Promise<Record<string, Checkpoint>> => {
  const updated: Record<string, Checkpoint> = {}
  for (const track of batch.tracks) {
    const checkpoint = await syncTrack(track, await originFor(track, prev, deps), deps)
    if (checkpoint) updated[track.checkpointKey] = checkpoint
  }
  return updated
}

/** `mtimeMs:size` — an artifact whose stamp is unchanged since the last cycle is already queued. */
type SeenStamps = Record<string, string>

const readSeen = async (path: string | undefined): Promise<SeenStamps> => {
  if (!path) return {}
  const raw = await readJson(path)
  if (typeof raw !== "object" || raw === null) return {}
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter(
      (pair): pair is [string, string] => typeof pair[1] === "string",
    ),
  )
}

const enqueueArtifacts = async (
  batch: SessionBatch,
  root: string,
  deps: WatcherDeps,
  artifacts: ArtifactCycleDeps,
): Promise<void> => {
  const observedAt = new Date(deps.clock.now()).toISOString()
  const seen = await readSeen(artifacts.statePath)
  const stamps: SeenStamps = { ...seen }
  const entries: QueueEntry[] = []

  for (const track of batch.tracks) {
    const cwd = track.project.root ?? root
    for (const candidate of collectArtifacts(track.records, cwd, deps.log)) {
      const resolved = await artifacts.realpath(candidate.path).catch(() => candidate.path)
      if (!isCapturable(resolved, root)) continue

      const stat = await artifacts.stat(resolved).catch(() => null)
      if (!stat) continue
      const stamp = `${stat.mtimeMs}:${stat.size}`
      if (seen[resolved] === stamp) continue
      stamps[resolved] = stamp

      entries.push({
        sessionId: track.sessionId,
        path: resolved,
        relativePath: relative(root, resolved),
        changeKind: candidate.changeKind,
        ...(candidate.backupFileName === undefined
          ? {}
          : { backupFileName: candidate.backupFileName }),
        ...(candidate.oldFragment === undefined ? {} : { oldFragment: candidate.oldFragment }),
        observedAt,
        attempts: 0,
      })
    }
  }

  if (entries.length === 0) return
  await enqueue(artifacts.queuePath, entries, deps.log)
  if (artifacts.statePath) await atomicWriteJson(artifacts.statePath, stamps)
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
  const { artifacts } = deps
  if (artifacts) {
    for (const batch of batches) {
      const root = batch.tracks[0]?.project.root
      // No root means the --project-slug override path, which synthesizes an identity without
      // one. Silent by design: it recurs every cycle for the whole run.
      if (root === undefined) continue
      await enqueueArtifacts(batch, root, deps, artifacts)
    }
  }

  const checkpoints = Object.assign({}, prev.checkpoints, ...results)
  const next: CheckpointStore = { checkpoints }
  await writeCheckpoints(deps.fs, config.statePath, next)
  return next
}
