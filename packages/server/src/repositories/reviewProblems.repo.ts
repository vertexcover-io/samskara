import type { Problem } from "@samskara/core"
import { and, asc, desc, eq, inArray } from "drizzle-orm"
import type { Querier } from "../db/client.js"
import { projects, reviewProblems } from "../db/schema.js"
import { visibleToUser } from "./projects.repo.js"

export type ReviewProblemRow = typeof reviewProblems.$inferSelect

/**
 * When a problem happened: the earliest time among the messages its evidence cites. Evidence
 * names them as msg-N, the Nth record of the export the reviewer read. Null when none of them
 * is in `records` or has a time.
 */
export const problemSeenAt = (
  problem: Pick<Problem, "evidence">,
  records: ReadonlyArray<{ readonly ts?: number }>,
): Date | null => {
  const times = problem.evidence.flatMap((item) => {
    const match = /^msg-(\d+)$/.exec(item.from)
    const ts = match === null ? undefined : records[Number(match[1])]?.ts
    return ts === undefined ? [] : [ts]
  })
  return times.length === 0 ? null : new Date(Math.min(...times))
}

/**
 * Saves a run's problems as a set. Only problems of `reviewId` are replaced: a fresh run has
 * none, and a retried try of the same run swaps its own partial set. Runs inside the caller's
 * transaction, with the review row itself. `records` is the export the reviewer read, so each
 * problem is stamped with when it happened (`problemSeenAt`); without it, or when no cited
 * message has a time, a problem is seen when it is saved.
 */
export const replaceReviewProblems = async (
  db: Querier,
  input: {
    readonly reviewId: string
    readonly sessionId: string
    readonly projectId: string
    readonly problems: ReadonlyArray<Problem>
    readonly records?: ReadonlyArray<{ readonly ts?: number }>
  },
): Promise<void> => {
  await db.delete(reviewProblems).where(eq(reviewProblems.reviewId, input.reviewId))
  if (input.problems.length === 0) return
  await db.insert(reviewProblems).values(
    input.problems.map((problem, position) => ({
      reviewId: input.reviewId,
      sessionId: input.sessionId,
      projectId: input.projectId,
      position,
      title: problem.title,
      class: problem.class,
      severity: problem.severity,
      severityReason: problem.severityReason,
      fixType: problem.fixType,
      description: problem.description,
      evidence: problem.evidence,
      learning: problem.learning,
      extra: problem.extra,
      ...seenAtOf(problem, input.records),
    })),
  )
}

/**
 * A session's problems in the order the reviewer wrote them, for whoever can see the session.
 * With `reviewIds`, only those reviews'.
 */
export const listProblemsForSession = async (
  db: Querier,
  userId: string,
  sessionId: string,
  reviewIds?: ReadonlyArray<string>,
): Promise<ReviewProblemRow[]> =>
  db
    .select()
    .from(reviewProblems)
    .innerJoin(projects, eq(projects.id, reviewProblems.projectId))
    .where(
      and(
        eq(reviewProblems.sessionId, sessionId),
        reviewIds === undefined ? undefined : inArray(reviewProblems.reviewId, [...reviewIds]),
        visibleToUser(db, userId),
      ),
    )
    .orderBy(asc(reviewProblems.reviewId), asc(reviewProblems.position))
    .then((rows) => rows.map((row) => row.reviewProblems))

/** The titles of the given runs' problems, newest run first, each run's in its own order. */
export const problemTitlesOf = async (
  db: Querier,
  reviewIds: ReadonlyArray<string>,
): Promise<string[]> => {
  if (reviewIds.length === 0) return []
  const rows = await db
    .select({ title: reviewProblems.title })
    .from(reviewProblems)
    .where(inArray(reviewProblems.reviewId, [...reviewIds]))
    .orderBy(desc(reviewProblems.createdAt), asc(reviewProblems.position))
  return rows.map((row) => row.title)
}

const seenAtOf = (
  problem: Problem,
  records: ReadonlyArray<{ readonly ts?: number }> | undefined,
): { seenAt?: Date } => {
  const seenAt = records === undefined ? null : problemSeenAt(problem, records)
  return seenAt === null ? {} : { seenAt }
}
