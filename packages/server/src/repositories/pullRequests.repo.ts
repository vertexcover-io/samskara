import { sql } from "drizzle-orm"
import type { PgColumn } from "drizzle-orm/pg-core"
import type { Querier } from "../db/client.js"
import { pullRequests, sessionPullRequests } from "../db/schema.js"

export type PullRequestState = "open" | "merged" | "closed"

/** An open pull request the nightly check asks GitHub about. */
export type PullRequestRef = {
  readonly id: string
  readonly owner: string
  readonly repo: string
  readonly number: number
}

/**
 * GitHub's answer for one pull request. `state` is null when GitHub returned no pull request:
 * deleted, or in a repo the token cannot read.
 */
export type PullRequestAnswer = {
  readonly id: string
  readonly state: PullRequestState | null
  readonly closedAt: Date | null
}

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

/**
 * Saves the nightly check's answers in one statement, stamping each row's `checkedAt`. A null
 * state keeps the row's state and close time: GitHub said nothing about it. Returns the rows
 * written.
 */
export const savePullRequestStates = async (
  db: Querier,
  answers: ReadonlyArray<PullRequestAnswer>,
  checkedAt: Date,
): Promise<number> => {
  if (answers.length === 0) return 0
  const rows = JSON.stringify(
    answers.map((a) => ({ id: a.id, state: a.state, closedAt: a.closedAt?.toISOString() ?? null })),
  )
  const saved = await db.execute<{ id: string }>(sql`
    update "pullRequests" pr set
      "state" = coalesce(x."state", pr."state"),
      "closedAt" = case when x."state" is null then pr."closedAt" else x."closedAt" end,
      "checkedAt" = ${checkedAt.toISOString()}::timestamptz
    from jsonb_to_recordset(${rows}::jsonb) as x("id" uuid, "state" text, "closedAt" timestamptz)
    where pr."id" = x."id"
    returning pr."id"`)
  return saved.length
}
