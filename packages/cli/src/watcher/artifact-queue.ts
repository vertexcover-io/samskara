import type pino from "pino"
import { z } from "zod"
import { atomicWriteJson, readJson, withFileLock } from "../config/atomic.js"

export const QUEUE_DEPTH_WARN_THRESHOLD = 200

const queueEntrySchema = z
  .object({
    sessionId: z.string().min(1),
    path: z.string().min(1),
    relativePath: z.string().min(1),
    projectRoot: z.string().min(1),
    changeKind: z.enum(["created", "edited", "editedUnknownBase"]),
    backupFileName: z.string().min(1).optional(),
    oldFragment: z.string().optional(),
    observedAt: z.string().datetime(),
    attempts: z.number().int().nonnegative(),
    nextAttemptAt: z.string().datetime().optional(),
  })
  .strict()
  .readonly()

const artifactQueueSchema = z
  .object({ version: z.literal(1), entries: z.array(queueEntrySchema).readonly() })
  .strict()
  .readonly()

export type ArtifactQueueEntry = z.infer<typeof queueEntrySchema>
export type ArtifactQueue = z.infer<typeof artifactQueueSchema>

const emptyQueue = (): ArtifactQueue => ({ version: 1, entries: [] })

export const readQueue = async (path: string): Promise<ArtifactQueue> => {
  const parsed = artifactQueueSchema.safeParse(await readJson(path))
  return parsed.success ? parsed.data : emptyQueue()
}

export const keyOf = (entry: ArtifactQueueEntry): string => `${entry.sessionId}:${entry.path}`

export const enqueue = async (
  path: string,
  entries: ReadonlyArray<ArtifactQueueEntry>,
  log?: pino.Logger,
): Promise<void> => {
  if (entries.length === 0) return

  await withFileLock(path, async () => {
    const current = await readQueue(path)
    const merged = new Map(current.entries.map((entry) => [keyOf(entry), entry]))
    for (const entry of entries) merged.set(keyOf(entry), entry)

    const next: ArtifactQueue = { version: 1, entries: [...merged.values()] }
    await atomicWriteJson(path, next)

    if (next.entries.length > QUEUE_DEPTH_WARN_THRESHOLD) {
      log?.warn(
        { depth: next.entries.length },
        "artifact queue is deep; uploads may be falling behind",
      )
    }
  })
}
