import { dirname, relative, resolve, sep } from "node:path"
import type { ArtifactUploadPayload } from "@samskara/core"
import type pino from "pino"
import { z } from "zod"
import { atomicWriteJson, readOrReset, readValidated, withFileLock } from "../config/atomic.js"
import { runGitOrNull } from "../git.js"
import { sleep } from "../io.js"
import { referencedPaths } from "./artifact-extract.js"
import {
  type ArtifactQueue,
  type ArtifactQueueEntry,
  enqueue,
  keyOf,
  readQueueOrReset,
} from "./artifact-queue.js"
import { type ArtifactUpload, type ArtifactUploadDeps, prepareUpload } from "./artifact-upload.js"
import { shouldCaptureArtifacts } from "./containment.js"

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

/** A UUID holds no colon and a Windows path does, so only the first colon separates the two. */
export const stateKey = (sessionId: string, path: string): string => `${sessionId}:${path}`

export const readArtifactState = async (path: string): Promise<ArtifactState> =>
  (await readValidated(path, artifactStateSchema)) ?? emptyState()

export const readArtifactStateOrReset = (path: string, log?: pino.Logger): Promise<ArtifactState> =>
  readOrReset(
    path,
    artifactStateSchema,
    emptyState,
    "artifact state file did not parse; resetting it, so every artifact re-uploads once",
    log,
  )

/**
 * `baseCaptured` records a completed upload, never an optimistic one. Losing this file entirely is
 * harmless: everything re-uploads once, and the server ignores a base for an artifact that already
 * has one.
 */
export const advanceArtifactState = async (
  path: string,
  key: string,
  next: ArtifactRecord,
  log?: pino.Logger,
): Promise<void> => {
  await withFileLock(path, async () => {
    const current = await readArtifactStateOrReset(path, log)
    await atomicWriteJson(path, {
      version: 1,
      artifacts: { ...current.artifacts, [key]: next },
    } satisfies ArtifactState)
  })
}

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
  /** Return as soon as nothing is due -- entries still in backoff stay queued. Tests and shutdown. */
  readonly drainOnce?: boolean
  readonly idlePollMs?: number
}

export type ArtifactWorkerDeps = ArtifactUploadDeps & {
  readonly sink: ArtifactSink
  readonly clock: { now(): number }
  readonly stopped?: () => boolean
}

const isDue = (entry: ArtifactQueueEntry, now: number): boolean =>
  entry.nextAttemptAt === undefined || Date.parse(entry.nextAttemptAt) <= now

/** Exponential from the attempt count already recorded: 5s, 10s, 20s, 40s. */
const backoffMs = (attempts: number): number => BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1)

const writeQueue = (path: string, entries: ReadonlyArray<ArtifactQueueEntry>): Promise<void> =>
  atomicWriteJson(path, { version: 1, entries } satisfies ArtifactQueue)

/**
 * Marks the entry in-flight without removing it: the queue file is the crash record, so an entry
 * only leaves it once `settle` confirms the upload finished.
 *
 * That is also why `inFlight` exists rather than the queue's dedup key alone. The key gives at most
 * one *queued* entry per path, but that entry stays queued while it uploads, so a second worker
 * would otherwise find it still due and claim it too. Two concurrent uploads of one path would race
 * to set its base, and the server keeps whichever lands first -- permanently, since every diff for
 * that artifact is rendered from it.
 */
const claim = async (
  config: ArtifactWorkerConfig,
  now: number,
  inFlight: Set<string>,
  log: pino.Logger,
): Promise<ArtifactQueueEntry | null> =>
  withFileLock(config.queuePath, async () => {
    const queue = await readQueueOrReset(config.queuePath, log)
    const entry = queue.entries.find((row) => !inFlight.has(keyOf(row)) && isDue(row, now))
    if (entry) inFlight.add(keyOf(entry))
    return entry ?? null
  })

/**
 * Applies only when the queued entry is still the one this worker claimed. Settling against a
 * newer one discards the edit that produced it, in both directions and without a symptom.
 */
const settle = async (
  config: ArtifactWorkerConfig,
  claimed: ArtifactQueueEntry,
  next: ArtifactQueueEntry | null,
  log: pino.Logger,
): Promise<void> => {
  await withFileLock(config.queuePath, async () => {
    const queue = await readQueueOrReset(config.queuePath, log)
    const key = keyOf(claimed)
    const queued = queue.entries.find((row) => keyOf(row) === key)

    // Stale: the queue holds a newer observation, so leave it for the next claim.
    if (queued && queued.observedAt !== claimed.observedAt) return

    const kept = queue.entries.filter((row) => keyOf(row) !== key)
    await writeQueue(config.queuePath, next === null ? kept : [...kept, next])
  })
}

const retried = (entry: ArtifactQueueEntry, now: number): ArtifactQueueEntry => {
  const attempts = entry.attempts + 1
  return { ...entry, attempts, nextAttemptAt: new Date(now + backoffMs(attempts)).toISOString() }
}

const REFERENCE_SCAN_TYPES = new Set(["text/html", "text/markdown"])

/**
 * `--literal-pathspecs` is a top-level git option and has to precede the subcommand -- placed after
 * it, git rejects it as unknown. Without it pathspec magic is on, and a file named `shot[1].png` is
 * read as a character class. Git answers relative to the directory it ran in -- the project root
 * here, not necessarily the repo root -- and omits untracked paths entirely, so the answer is a set
 * rather than a positional mapping.
 *
 * Callers must pass a non-empty set: `git ls-files` with no pathspec lists the entire repository.
 */
const untrackedAmong = async (
  projectRoot: string,
  paths: ReadonlyArray<string>,
  log: pino.Logger,
): Promise<ReadonlyArray<string>> => {
  // Asked as a question that succeeds, because a failing one cannot say why: `ls-files` exits 128
  // both outside a repo and on a repo it could not read, and only the first means nothing is
  // tracked. A repo that will not answer keeps nothing rather than uploading files git already has.
  const insideRepo = await runGitOrNull(["rev-parse", "--is-inside-work-tree"], projectRoot, log)
  if (insideRepo !== "true") return paths

  const relatives = paths.map((path) => relative(projectRoot, path))
  const output = await runGitOrNull(
    ["--literal-pathspecs", "ls-files", "-z", "--", ...relatives],
    projectRoot,
    log,
  )
  if (output === null) return []

  const tracked = new Set(
    output
      .split("\0")
      .filter((line) => line.length > 0)
      .map((line) => resolve(projectRoot, line)),
  )
  return paths.filter((path) => !tracked.has(path))
}

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
  entry: ArtifactQueueEntry,
  upload: ArtifactUpload,
): Promise<void> => {
  try {
    if (upload.encoding !== "utf8") return
    if (!REFERENCE_SCAN_TYPES.has(upload.mimeType)) return

    const refs = referencedPaths(upload.currentContent, dirname(entry.path))
    if (refs.length === 0) return

    const projectRoot = entry.projectRoot
    const decisions = await shouldCaptureArtifacts(refs, { projectRoot, allowScratch: false })
    for (const [index, decision] of decisions.entries()) {
      if (decision.ok) continue
      deps.log.debug({ ref: refs[index], reason: decision.reason }, "reference not captured")
    }

    const survivors = decisions.flatMap((decision) => (decision.ok ? [decision.path] : []))
    // Must follow the capture check: one path outside the root makes `git ls-files` exit 128 and
    // print nothing for the whole batch, discarding every valid reference with it.
    const kept =
      survivors.length === 0 ? [] : await untrackedAmong(projectRoot, survivors, deps.log)

    if (kept.length > 0) {
      const observedAt = new Date(deps.clock.now()).toISOString()
      const entries = kept.map(
        (ref): ArtifactQueueEntry => ({
          sessionId: entry.sessionId,
          path: ref,
          relativePath: relative(projectRoot, ref),
          projectRoot,
          changeKind: "created",
          observedAt,
          attempts: 0,
        }),
      )
      await enqueue(config.queuePath, entries, deps.log)
    }

    deps.log.info(
      {
        path: entry.path,
        found: refs.length,
        skipped: refs.length - survivors.length,
        alreadyTracked: survivors.length - kept.length,
        enqueued: kept.length,
      },
      "artifact reference scan complete",
    )
  } catch (error) {
    deps.log.warn({ path: entry.path, err: error }, "artifact reference scan failed")
  }
}

/** Returns false when nothing was due, so the caller can idle rather than spin. */
const processOne = async (
  config: ArtifactWorkerConfig,
  deps: ArtifactWorkerDeps,
  inFlight: Set<string>,
): Promise<boolean> => {
  const now = deps.clock.now()
  const entry = await claim(config, now, inFlight, deps.log)
  if (!entry) return false

  try {
    const upload = await prepareUpload(deps, entry)
    // A vanished or oversize file: not an error, and no state to advance.
    if (!upload) {
      await settle(config, entry, null, deps.log)
      return true
    }

    // The authoritative churn layer: the cycle's mtime+size check is cheap but lies when a file
    // is rewritten with identical bytes.
    const state = await readArtifactStateOrReset(config.statePath, deps.log)
    const key = stateKey(entry.sessionId, entry.path)
    if (state.artifacts[key]?.currentHash === upload.currentHash) {
      deps.log.debug(
        { path: entry.path, hash: upload.currentHash },
        "artifact bytes unchanged since the last upload; skipping",
      )
      await settle(config, entry, null, deps.log)
      return true
    }

    const { status } = await deps.sink.send(upload).catch((): ArtifactSinkResult => ({ status: 0 }))

    if (status >= 200 && status < 300) {
      deps.log.debug(
        {
          path: entry.path,
          status,
          changeKind: upload.changeKind,
          bytes: upload.currentContent.length,
          baseCaptured: upload.baseContent !== undefined,
          attempts: entry.attempts + 1,
        },
        "artifact uploaded",
      )
      await settle(config, entry, null, deps.log)
      await advanceArtifactState(config.statePath, key, {
        currentHash: upload.currentHash,
        baseCaptured: upload.baseContent !== undefined,
      })
      await enqueueReferences(config, deps, entry, upload)
      return true
    }

    // Retryable for reasons the statuses would not usually suggest: 409 is the session row not
    // existing *yet*, since artifacts can reach the server before the transcript that owns them,
    // and 0 is the sink's marker for a network error rather than any HTTP reply. The rest of 4xx
    // is the server refusing this payload, which no amount of retrying changes.
    const retryable = status === 409 || status >= 500 || status === 0
    const context = { path: entry.path, status, attempts: entry.attempts + 1 }

    if (retryable && entry.attempts + 1 < MAX_ATTEMPTS) {
      deps.log.debug(context, "artifact upload failed; retrying after backoff")
      await settle(config, entry, retried(entry, now), deps.log)
      return true
    }

    // State is not advanced either way, so a later edit of the same file re-enqueues it and the
    // artifact gets another chance.
    if (retryable) {
      deps.log.warn(context, "artifact upload exhausted its attempts; dropped")
    } else {
      // The server refused this payload: a bug or an expired token, not something time repairs.
      deps.log.error(context, "artifact upload rejected; dropped without retrying")
    }
    await settle(config, entry, null, deps.log)
    return true
  } finally {
    inFlight.delete(keyOf(entry))
  }
}

const runWorker = async (
  config: ArtifactWorkerConfig,
  deps: ArtifactWorkerDeps,
  inFlight: Set<string>,
): Promise<void> => {
  const stopped = deps.stopped ?? (() => false)
  for (;;) {
    if (stopped()) return
    // Every expected failure is already a status code, so anything thrown here is unexpected.
    const worked = await processOne(config, deps, inFlight).catch((err: unknown) => {
      deps.log.error({ err }, "artifact worker iteration failed")
      return false
    })
    if (worked) continue
    if (config.drainOnce) return
    await sleep(config.idlePollMs ?? IDLE_POLL_MS)
  }
}

/**
 * An independent loop in the daemon process: an artifact failure never rolls back a message
 * checkpoint -- the two states advance separately, in separate files.
 */
export const runArtifactWorkers = async (
  config: ArtifactWorkerConfig,
  deps: ArtifactWorkerDeps,
): Promise<void> => {
  const inFlight = new Set<string>()
  const count = config.workers ?? DEFAULT_WORKER_COUNT
  await Promise.all(Array.from({ length: count }, () => runWorker(config, deps, inFlight)))
}
