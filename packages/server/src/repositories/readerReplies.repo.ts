import { eq, inArray } from "drizzle-orm"
import type { Querier } from "../db/client.js"
import { reviewReaderReplies } from "../db/schema.js"

/** Every reply saved for this review, by the hash of the piece its reader read. */
export const savedReaderReplies = async (
  db: Querier,
  reviewId: string,
): Promise<ReadonlyMap<string, string>> => {
  const rows = await db
    .select({ pieceHash: reviewReaderReplies.pieceHash, reply: reviewReaderReplies.reply })
    .from(reviewReaderReplies)
    .where(eq(reviewReaderReplies.reviewId, reviewId))
  return new Map(rows.map((row) => [row.pieceHash, row.reply]))
}

/** Keeps one finished reader's reply; a second save of the same piece keeps the first. */
export const saveReaderReply = async (
  db: Querier,
  input: { readonly reviewId: string; readonly pieceHash: string; readonly reply: string },
): Promise<void> => {
  await db.insert(reviewReaderReplies).values(input).onConflictDoNothing()
}

/** Drops every reply saved for these reviews: each one ended, or a new review starts on its row. */
export const deleteReaderReplies = async (
  db: Querier,
  reviewIds: ReadonlyArray<string>,
): Promise<void> => {
  if (reviewIds.length === 0) return
  await db.delete(reviewReaderReplies).where(inArray(reviewReaderReplies.reviewId, [...reviewIds]))
}
