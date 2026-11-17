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

/** One branch of tonight's candidate sessions with no linked pull request, and those sessions. */
export type BranchRef = {
  readonly repoId: string
  readonly owner: string
  readonly repo: string
  readonly branch: string
  readonly sessionIds: ReadonlyArray<string>
}

/** A pull request GitHub found with a branch as its head, in any state. */
export type FoundPullRequest = {
  readonly number: number
  readonly title: string | null
  readonly baseBranch: string | null
  readonly headBranch: string | null
  readonly state: PullRequestState
  readonly closedAt: Date | null
}

/** GitHub's answer for one branch: every pull request with it as head, often none. */
export type BranchAnswer = {
  readonly branch: BranchRef
  readonly pullRequests: ReadonlyArray<FoundPullRequest>
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

/**
 * Saves the pull requests GitHub found on each branch, with the state it gave stamped as checked
 * at `checkedAt`, and links every session on that branch to each of them. GitHub's state replaces
 * the stored one, being newer; a stored title or branch is kept when GitHub sends none. Not one
 * transaction on purpose: a pull request that fails to save must not undo the links already made
 * for other branches. Returns the session links made; one that already existed is not counted.
 */
export const linkBranchPullRequests = async (
  db: Querier,
  answers: ReadonlyArray<BranchAnswer>,
  checkedAt: Date,
): Promise<number> => {
  const found = answers.flatMap((answer) => answer.pullRequests.map((pr) => ({ answer, pr })))
  const linked = await Promise.all(
    found.map(async ({ answer, pr }) => {
      const [row] = await db
        .insert(pullRequests)
        .values({ repoId: answer.branch.repoId, ...pr, checkedAt })
        .onConflictDoUpdate({
          target: [pullRequests.repoId, pullRequests.number],
          set: {
            title: enrich(pullRequests.title),
            baseBranch: enrich(pullRequests.baseBranch),
            headBranch: enrich(pullRequests.headBranch),
            state: pr.state,
            closedAt: pr.closedAt,
            checkedAt,
            updatedAt: sql`now()`,
          },
        })
        .returning({ id: pullRequests.id })
      if (!row) throw new Error("pull request upsert resolved no row")
      if (answer.branch.sessionIds.length === 0) return 0
      const links = await db
        .insert(sessionPullRequests)
        .values(answer.branch.sessionIds.map((sessionId) => ({ sessionId, prId: row.id })))
        .onConflictDoNothing()
        .returning({ sessionId: sessionPullRequests.sessionId })
      return links.length
    }),
  )
  return linked.reduce((sum, count) => sum + count, 0)
}
