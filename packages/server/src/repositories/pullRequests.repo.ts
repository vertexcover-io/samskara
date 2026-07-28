import { sql } from "drizzle-orm"
import type { Querier } from "../db/client.js"
import { pullRequests, sessionPullRequests } from "../db/schema.js"

export type ObservedPullRequest = {
  readonly repoId: string
  readonly number: number
  readonly title?: string
  readonly sessionId: string
  readonly createdHere: boolean
  readonly messageId?: string
}

/**
 * A PR is mutable -- a title can change between the call that opened it and a later read -- so
 * this upserts where commits freeze their first observation. `createdHere` is the exception: it
 * is OR-ed, because once a session is known to have opened a PR, a later `gh pr view` in the
 * same session must not downgrade that to a mere reference.
 */
export const upsertObserved = async (
  db: Querier,
  rows: ReadonlyArray<ObservedPullRequest>,
): Promise<void> => {
  for (const row of rows) {
    const [pr] = await db
      .insert(pullRequests)
      .values({ repoId: row.repoId, number: row.number, title: row.title })
      .onConflictDoUpdate({
        target: [pullRequests.repoId, pullRequests.number],
        set: {
          title: sql`coalesce(excluded."title", "pullRequests"."title")`,
          updatedAt: sql`now()`,
        },
      })
      .returning({ id: pullRequests.id })
    if (!pr) throw new Error("pull request upsert resolved no row")

    await db
      .insert(sessionPullRequests)
      .values({
        sessionId: row.sessionId,
        prId: pr.id,
        createdHere: row.createdHere,
        messageId: row.messageId,
      })
      .onConflictDoUpdate({
        target: [sessionPullRequests.sessionId, sessionPullRequests.prId],
        set: {
          createdHere: sql`"sessionPullRequests"."createdHere" or excluded."createdHere"`,
          messageId: sql`coalesce("sessionPullRequests"."messageId", excluded."messageId")`,
        },
      })
  }
}
