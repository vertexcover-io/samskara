import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm"
import type { Db } from "../db/client.js"
import { sessionChunk } from "../db/schema.js"
import { EMBEDDING_LEASE_MINUTES, EMBEDDING_MAX_ATTEMPTS } from "./constants.js"
import type { EmbeddingClient } from "./embedding.js"

export type EmbeddingBatchResult = {
  readonly claimed: number
  readonly embedded: number
  readonly failed: number
}

type ClaimedRow = { readonly id: string; readonly embedText: string }

/**
 * Claims a batch under `FOR UPDATE SKIP LOCKED` so two concurrent workers never claim the same
 * row: a row is eligible when its embedding is still null, it has not exhausted its
 * attempts, and any earlier claim's lease has expired. `attempts` increments at claim time, not
 * on failure -- a row that crashes the worker mid-batch still counts its try, so a poison chunk
 * cannot be retried forever.
 */
const claimBatch = (db: Db, limit: number): Promise<ReadonlyArray<ClaimedRow>> =>
  db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: sessionChunk.id, embedText: sessionChunk.embedText })
      .from(sessionChunk)
      .where(
        and(
          isNull(sessionChunk.embedding),
          lt(sessionChunk.attempts, EMBEDDING_MAX_ATTEMPTS),
          or(
            isNull(sessionChunk.claimedAt),
            lt(
              sessionChunk.claimedAt,
              sql`now() - interval '1 minute' * ${EMBEDDING_LEASE_MINUTES}`,
            ),
          ),
        ),
      )
      .orderBy(asc(sessionChunk.createdAt))
      .limit(limit)
      .for("update", { skipLocked: true })

    if (rows.length === 0) return rows

    await tx
      .update(sessionChunk)
      .set({ claimedAt: sql`now()`, attempts: sql`${sessionChunk.attempts} + 1` })
      .where(
        inArray(
          sessionChunk.id,
          rows.map((row) => row.id),
        ),
      )

    return rows
  })

/** One drain-loop batch: claim outstanding rows, embed them, and write the vectors back. */
export const runEmbeddingBatch = async (
  db: Db,
  client: EmbeddingClient,
  limit: number,
): Promise<EmbeddingBatchResult> => {
  const claimed = await claimBatch(db, limit)
  if (claimed.length === 0) return { claimed: 0, embedded: 0, failed: 0 }

  let vectors: ReadonlyArray<ReadonlyArray<number>>
  try {
    vectors = await client.embedDocuments(claimed.map((row) => row.embedText))
  } catch {
    return { claimed: claimed.length, embedded: 0, failed: claimed.length }
  }

  let embedded = 0
  for (const [index, row] of claimed.entries()) {
    const vector = vectors[index]
    if (!vector) continue
    await db
      .update(sessionChunk)
      .set({ embedding: [...vector] })
      .where(eq(sessionChunk.id, row.id))
    embedded += 1
  }

  return { claimed: claimed.length, embedded, failed: claimed.length - embedded }
}

export type EmbeddingWorkerDeps = {
  readonly db: Db
  readonly client: EmbeddingClient
  readonly intervalMs?: number
  readonly limit?: number
  readonly onError?: (error: unknown) => void
}

const DEFAULT_INTERVAL_MS = 30_000
const DEFAULT_BATCH_LIMIT = 50

/**
 * `embedding IS NULL` is already a complete, self-healing description of outstanding work,
 * so this is nothing but a poll loop -- no queue, no enqueue call anywhere in the codebase.
 */
export const startEmbeddingWorker = (deps: EmbeddingWorkerDeps): { stop(): void } => {
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS
  const limit = deps.limit ?? DEFAULT_BATCH_LIMIT
  const onError = deps.onError ?? (() => {})

  const handle = setInterval(() => {
    runEmbeddingBatch(deps.db, deps.client, limit).catch(onError)
  }, intervalMs)

  return { stop: () => clearInterval(handle) }
}
