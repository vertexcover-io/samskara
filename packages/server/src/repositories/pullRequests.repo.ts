import { sql } from "drizzle-orm"
import type { PgColumn } from "drizzle-orm/pg-core"
import type { Querier } from "../db/client.js"
import { pullRequests, sessionPullRequests } from "../db/schema.js"

export type ObservedPullRequest = {
  readonly repoId: string
  readonly number: number
  readonly sessionId: string
  readonly messageId?: string
  readonly title?: string
  readonly baseBranch?: string
  readonly headBranch?: string
}

/**
 * Incoming non-null wins, but a null never displaces a stored value: a re-parse that resolves the
 * PR from its URL alone -- an output-only candidate, no command to read -- must not blank the
 * title and branches an earlier pass captured from the invocation.
 */
const enrich = (column: PgColumn) =>
  sql`coalesce(${sql.raw(`excluded."${column.name}"`)}, ${column})`

/**
 * Only PRs the session opened arrive here. The conflict update is what lets a re-parse of the
 * same transcript resolve the existing row's id instead of returning nothing.
 */
export const insertOpened = async (
  db: Querier,
  rows: ReadonlyArray<ObservedPullRequest>,
): Promise<void> => {
  for (const row of rows) {
    const [pr] = await db
      .insert(pullRequests)
      .values({
        repoId: row.repoId,
        number: row.number,
        title: row.title,
        baseBranch: row.baseBranch,
        headBranch: row.headBranch,
      })
      .onConflictDoUpdate({
        target: [pullRequests.repoId, pullRequests.number],
        set: {
          title: enrich(pullRequests.title),
          baseBranch: enrich(pullRequests.baseBranch),
          headBranch: enrich(pullRequests.headBranch),
          updatedAt: sql`now()`,
        },
      })
      .returning({ id: pullRequests.id })
    if (!pr) throw new Error("pull request upsert resolved no row")

    await db
      .insert(sessionPullRequests)
      .values({ sessionId: row.sessionId, prId: pr.id, messageId: row.messageId })
      .onConflictDoNothing()
  }
}
