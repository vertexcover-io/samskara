import type pino from "pino"
import { z } from "zod"
import { atomicWriteJson, readOrReset, readValidated, withFileLock } from "../config/atomic.js"
import { persistedApiUrl } from "../config/server-scope.js"
import { mergeArtifact, type PotentialArtifact } from "./artifact-extract.js"

export const QUEUE_DEPTH_WARN_THRESHOLD = 200

const queueEntrySchema = z
  .object({
    sessionId: z.string().min(1),
    path: z.string().min(1),
    relativePath: z.string().min(1),
    projectRoot: z.string().min(1),
    created: z.boolean(),
    base: z.string().optional(),
    observedAt: z.string().datetime(),
    attempts: z.number().int().nonnegative(),
    nextAttemptAt: z.string().datetime().optional(),
  })
  .strict()
  .readonly()

const artifactQueueSchema = z
  .object({
    version: z.literal(1),
    apiBase: z.string().optional(),
    entries: z.array(queueEntrySchema).readonly(),
  })
  .strict()
  .readonly()

export type ArtifactQueueEntry = z.infer<typeof queueEntrySchema>
export type ArtifactQueue = z.infer<typeof artifactQueueSchema>

const emptyQueue = (): ArtifactQueue => ({ version: 1, entries: [] })

export const readQueue = async (path: string): Promise<ArtifactQueue> =>
  (await readValidated(path, artifactQueueSchema)) ?? emptyQueue()

export const readQueueOrReset = (path: string, log?: pino.Logger): Promise<ArtifactQueue> =>
  readOrReset(
    path,
    artifactQueueSchema,
    emptyQueue,
    "artifact queue file did not parse; resetting it and dropping every entry it held",
    log,
  )

export const keyOf = (entry: ArtifactQueueEntry): string => `${entry.sessionId}:${entry.path}`

const artifactOf = (entry: ArtifactQueueEntry): PotentialArtifact => ({
  path: entry.path,
  created: entry.created,
  ...(entry.base === undefined ? {} : { base: entry.base }),
})

/** Latest-wins, except the base, which folds, and the backoff, which a new sighting cannot reset. */
const fold = (prev: ArtifactQueueEntry, next: ArtifactQueueEntry): ArtifactQueueEntry => {
  const artifact = mergeArtifact(artifactOf(prev), artifactOf(next))
  return {
    ...next,
    created: artifact.created,
    ...(artifact.base === undefined ? {} : { base: artifact.base }),
    attempts: Math.max(prev.attempts, next.attempts),
    ...(prev.nextAttemptAt === undefined ? {} : { nextAttemptAt: prev.nextAttemptAt }),
  }
}

export const enqueue = async (
  path: string,
  entries: ReadonlyArray<ArtifactQueueEntry>,
  log?: pino.Logger,
): Promise<void> => {
  if (entries.length === 0) return

  await withFileLock(path, async () => {
    const current = await readQueueOrReset(path, log)
    const merged = new Map(current.entries.map((entry) => [keyOf(entry), entry]))
    for (const entry of entries) {
      const prev = merged.get(keyOf(entry))
      merged.set(keyOf(entry), prev === undefined ? entry : fold(prev, entry))
    }

    const next: ArtifactQueue = {
      version: 1,
      apiBase: persistedApiUrl(),
      entries: [...merged.values()],
    }
    await atomicWriteJson(path, next)

    if (next.entries.length > QUEUE_DEPTH_WARN_THRESHOLD) {
      log?.warn(
        { depth: next.entries.length },
        "artifact queue is deep; uploads may be falling behind",
      )
    }
  })
}
