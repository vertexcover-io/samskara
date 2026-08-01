import { sql } from "drizzle-orm"
import type { Querier } from "../db/client.js"
import { pullRequests, sessionPullRequests } from "../db/schema.js"

export type ObservedPullRequest = {
  readonly repoId: string
  readonly number: number
  readonly sessionId: string
  readonly messageId?: string
}

/**
 * Only PRs the session opened arrive here. The no-op conflict update is what lets a re-parse of
 * the same transcript resolve the existing row's id instead of returning nothing.
 */
export const insertOpened = async (
  db: Querier,
  rows: ReadonlyArray<ObservedPullRequest>,
): Promise<void> => {
  for (const row of rows) {
    const [pr] = await db
      .insert(pullRequests)
      .values({ repoId: row.repoId, number: row.number })
      .onConflictDoUpdate({
        target: [pullRequests.repoId, pullRequests.number],
        set: { updatedAt: sql`now()` },
      })
      .returning({ id: pullRequests.id })
    if (!pr) throw new Error("pull request upsert resolved no row")

    await db
      .insert(sessionPullRequests)
      .values({ sessionId: row.sessionId, prId: pr.id, messageId: row.messageId })
      .onConflictDoNothing()
  }
}
