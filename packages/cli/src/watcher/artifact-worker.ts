import { stat } from "node:fs/promises"
import { dirname, relative, sep } from "node:path"
import type { ArtifactUploadPayload } from "@samskara/core"
import { z } from "zod"
import { atomicWriteJson, readJson, withFileLock } from "../config/atomic.js"
import { referencedPaths } from "./artifact-extract.js"
import { type ArtifactQueue, type QueueEntry, enqueue, keyOf, readQueue } from "./artifact-queue.js"
import { type ArtifactUpload, type ArtifactUploadDeps, prepareUpload } from "./artifact-upload.js"
import { isCapturable } from "./containment.js"

// --- upload state: the worker's own record of what already landed --------------------------

const artifactRecordSchema = z
  .object({ currentHash: z.string().min(1), baseCaptured: z.boolean() })
  .strict()
  .readonly()

const artifactStateSchema = z
  .object({ version: z.literal(1), artifacts: z.record(z.string(), artifactRecordSchema) })
  .strict()
  .readonly()

export type ArtifactRecord = z.infer<typeof artifactRecordSchema>
export type ArtifactState = z.infer<typeof artifactStateSchema>

const emptyState = (): ArtifactState => ({ version: 1, artifacts: {} })

/**
 * Session ids are UUIDs, so no colon appears in the first component -- but an absolute path on
 * Windows does, which is why the key splits on the first colon rather than the last.
 */
export const stateKey = (sessionId: string, path: string): string => `${sessionId}:${path}`

export const readArtifactState = async (path: string): Promise<ArtifactState> => {
  const parsed = artifactStateSchema.safeParse(await readJson(path))
  return parsed.success ? parsed.data : emptyState()
}

/**
 * `baseCaptured` records a completed action, never an optimistic one: it is written only after an
 * upload that carried a base succeeded. Losing this file entirely is harmless -- everything
 * re-uploads once, and the server's base-freeze rule ignores the redundant base.
 */
export const advanceArtifactState = async (
  path: string,
  key: string,
  next: ArtifactRecord,
): Promise<void> => {
  await withFileLock(path, async () => {
    const current = await readArtifactState(path)
    await atomicWriteJson(path, {
      version: 1,
      artifacts: { ...current.artifacts, [key]: next },
    } satisfies ArtifactState)
  })
}

// --- queue processing ----------------------------------------------------------------------

export const DEFAULT_WORKER_COUNT = 3
export const MAX_ATTEMPTS = 5
export const BACKOFF_BASE_MS = 5_000
export const IDLE_POLL_MS = 1_000

export type ArtifactSinkResult = { readonly status: number; readonly error?: string }

export type ArtifactSink = {
  send(payload: ArtifactUploadPayload): Promise<ArtifactSinkResult>
}

export type ArtifactWorkerConfig = {
  readonly queuePath: string
  readonly statePath: string
  readonly workers?: number
  /** Drain once and return, rather than looping until stopped. Used by tests and by shutdown. */
  readonly drainOnce?: boolean
  readonly idlePollMs?: number
}

export type ArtifactWorkerDeps = ArtifactUploadDeps & {
  readonly sink: ArtifactSink
  readonly clock: { now(): number }
  readonly stopped?: () => boolean
}

const isDue = (entry: QueueEntry, now: number): boolean =>
  entry.nextAttemptAt === undefined || Date.parse(entry.nextAttemptAt) <= now

/** Exponential from the attempt count already recorded: 5s, 10s, 20s, 40s. */
const backoffMs = (attempts: number): number => BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1)

const writeQueue = (path: string, entries: ReadonlyArray<QueueEntry>): Promise<void> =>
  atomicWriteJson(path, { version: 1, entries } satisfies ArtifactQueue)

/**
 * Claiming happens under the queue's file lock and marks the entry in-flight, so two workers never
 * take the same one. The queue's `(sessionId, path)` dedup key then guarantees at most one
 * in-flight upload per path, which is what keeps the base-freeze rule from racing with itself.
 */
const claim = async (
  config: ArtifactWorkerConfig,
  now: number,
  inFlight: Set<string>,
): Promise<QueueEntry | null> =>
  withFileLock(config.queuePath, async () => {
    const queue = await readQueue(config.queuePath)
    const entry = queue.entries.find((row) => !inFlight.has(keyOf(row)) && isDue(row, now))
    if (entry) inFlight.add(keyOf(entry))
    return entry ?? null
  })

/**
 * Replaces the claimed entry, or removes it when `next` is null. Never touches other entries.
 *
 * The entry stays queued for the whole upload, so the cycle can re-enqueue the same path while it
 * is in flight -- meaning the file was edited again. That entry is a strictly newer observation and
 * must survive: removing it on success would drop an edit nobody ever uploads, and overwriting it
 * on retry would resurrect content the agent has already replaced. Both are silent data loss, so a
 * settle only applies when the queued entry is still the one this worker claimed.
 */
const settle = async (
  config: ArtifactWorkerConfig,
  claimed: QueueEntry,
  next: QueueEntry | null,
): Promise<void> => {
  await withFileLock(config.queuePath, async () => {
    const queue = await readQueue(config.queuePath)
    const key = keyOf(claimed)
    const queued = queue.entries.find((row) => keyOf(row) === key)

    // Re-enqueued mid-upload: the cycle observed a newer edit, so this settle is stale. Leave it
    // queued -- the next claim picks up the fresh entry and uploads what the file says now.
    if (queued && queued.observedAt !== claimed.observedAt) return

    const kept = queue.entries.filter((row) => keyOf(row) !== key)
    await writeQueue(config.queuePath, next === null ? kept : [...kept, next])
  })
}

const retried = (entry: QueueEntry, now: number): QueueEntry => {
  const attempts = entry.attempts + 1
  return { ...entry, attempts, nextAttemptAt: new Date(now + backoffMs(attempts)).toISOString() }
}

const toPayload = (upload: ArtifactUpload): ArtifactUploadPayload => upload

type Outcome = "done" | "retry" | "drop"

const outcomeFor = (result: ArtifactSinkResult): Outcome => {
  if (result.status >= 200 && result.status < 300) return "done"
  if (result.status === 409) return "retry"
  if (result.status >= 500 || result.status === 0) return "retry"
  return "drop"
}

const REFERENCE_SCAN_EXTENSIONS = [".html", ".htm", ".md"]

const isReferenceScannable = (path: string): boolean => {
  const lower = path.toLowerCase()
  return REFERENCE_SCAN_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

/**
 * `entry.relativePath` is always a suffix of `entry.path` (both required by the queue schema),
 * so the project root is what remains once that suffix and its separator are trimmed off.
 */
const projectRootOf = (entry: QueueEntry): string => {
  const withoutRelative = entry.path.slice(0, entry.path.length - entry.relativePath.length)
  return withoutRelative.endsWith(sep) ? withoutRelative.slice(0, -1) : withoutRelative
}

const isExistingFile = async (path: string): Promise<boolean> =>
  stat(path)
    .then((info) => info.isFile())
    .catch(() => false)

const capturableReferences = async (
  refs: ReadonlyArray<string>,
  projectRoot: string,
): Promise<ReadonlyArray<string>> => {
  const survivors: string[] = []
  for (const ref of refs) {
    if (!(await isExistingFile(ref))) continue
    if (!isCapturable(ref, projectRoot)) continue
    survivors.push(ref)
  }
  return survivors
}

const referenceEntry = (
  ref: string,
  projectRoot: string,
  entry: QueueEntry,
  now: number,
): QueueEntry => ({
  sessionId: entry.sessionId,
  path: ref,
  relativePath: relative(projectRoot, ref),
  changeKind: "created",
  observedAt: new Date(now).toISOString(),
  attempts: 0,
})

/**
 * Runs on the branch where `entry`'s upload just succeeded and its hash is already recorded, so a
 * document that links back to itself (directly or through another document) short-circuits on the
 * churn check before it can be scanned again -- see `advanceArtifactState` above this branch.
 *
 * A throw here must never turn an already-succeeded upload into a retry, so the whole body is
 * guarded and logged rather than propagated.
 */
const enqueueReferences = async (
  config: ArtifactWorkerConfig,
  deps: ArtifactWorkerDeps,
  entry: QueueEntry,
  upload: ArtifactUpload,
): Promise<void> => {
  try {
    if (upload.encoding !== "utf8") return
    if (!isReferenceScannable(entry.path)) return

    const refs = referencedPaths(upload.currentContent, dirname(entry.path))
    if (refs.length === 0) return

    const projectRoot = projectRootOf(entry)
    const survivors = await capturableReferences(refs, projectRoot)
    if (survivors.length === 0) return

    const now = deps.clock.now()
    const entries = survivors.map((ref) => referenceEntry(ref, projectRoot, entry, now))
    await enqueue(config.queuePath, entries, deps.log)
  } catch (error) {
    deps.log.warn({ path: entry.path, err: error }, "artifact reference scan failed")
  }
}

/**
 * Processes at most one entry. Returns false when nothing was due, so the caller can idle rather
 * than spin.
 */
const processOne = async (
  config: ArtifactWorkerConfig,
  deps: ArtifactWorkerDeps,
  inFlight: Set<string>,
): Promise<boolean> => {
  const now = deps.clock.now()
  const entry = await claim(config, now, inFlight)
  if (!entry) return false

  try {
    const upload = await prepareUpload(deps, entry)
    // A vanished or oversize file: not an error, and no state to advance.
    if (!upload) {
      await settle(config, entry, null)
      return true
    }

    // The authoritative churn layer: the cycle's mtime+size check is cheap but lies when a file
    // is rewritten with identical bytes.
    const state = await readArtifactState(config.statePath)
    const key = stateKey(entry.sessionId, entry.path)
    if (state.artifacts[key]?.currentHash === upload.currentHash) {
      await settle(config, entry, null)
      return true
    }

    const result = await deps.sink
      .send(toPayload(upload))
      .catch((): ArtifactSinkResult => ({ status: 0 }))

    const outcome = outcomeFor(result)

    if (outcome === "done") {
      await settle(config, entry, null)
      await advanceArtifactState(config.statePath, key, {
        currentHash: upload.currentHash,
        baseCaptured: upload.baseContent !== undefined,
      })
      await enqueueReferences(config, deps, entry, upload)
      return true
    }

    if (outcome === "retry" && entry.attempts + 1 < MAX_ATTEMPTS) {
      await settle(config, entry, retried(entry, now))
      return true
    }

    // Permanent, or out of attempts. State is not advanced, so a later edit of the same file
    // re-enqueues it and the artifact gets another chance.
    deps.log.warn(
      { path: entry.path, status: result.status, attempts: entry.attempts + 1 },
      "artifact upload dropped",
    )
    await settle(config, entry, null)
    return true
  } finally {
    inFlight.delete(keyOf(entry))
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const runWorker = async (
  config: ArtifactWorkerConfig,
  deps: ArtifactWorkerDeps,
  inFlight: Set<string>,
): Promise<void> => {
  const stopped = deps.stopped ?? (() => false)
  for (;;) {
    if (stopped()) return
    const worked = await processOne(config, deps, inFlight).catch((err: unknown) => {
      deps.log.warn({ err }, "artifact worker iteration failed")
      return false
    })
    if (worked) continue
    if (config.drainOnce) return
    await sleep(config.idlePollMs ?? IDLE_POLL_MS)
  }
}

/**
 * A fixed pool running as an independent loop in the daemon process. Artifact failure never rolls
 * back a message checkpoint -- the two states advance independently, in separate files.
 */
export const runArtifactWorkers = async (
  config: ArtifactWorkerConfig,
  deps: ArtifactWorkerDeps,
): Promise<void> => {
  const inFlight = new Set<string>()
  const count = config.workers ?? DEFAULT_WORKER_COUNT
  await Promise.all(Array.from({ length: count }, () => runWorker(config, deps, inFlight)))
}
