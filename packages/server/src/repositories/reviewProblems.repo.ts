import type { Problem } from "@samskara/core"
import { and, asc, eq } from "drizzle-orm"
import type { Querier } from "../db/client.js"
import { projects, reviewProblems } from "../db/schema.js"
import { visibleToUser } from "./projects.repo.js"

export type ReviewProblemRow = typeof reviewProblems.$inferSelect

/**
 * Saves a review's problems, replacing whatever that review had before: a redo supersedes
 * the review row in place, so its problems are swapped as a set rather than added to. Runs
 * inside the caller's transaction, with the review row itself.
 */
export const replaceReviewProblems = async (
  db: Querier,
  input: {
    readonly reviewId: string
    readonly sessionId: string
    readonly projectId: string
    readonly problems: ReadonlyArray<Problem>
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
    })),
  )
}

/**
 * A session's problems in the order the reviewer wrote them, for whoever can see the session.
 * With `reviewId`, only that review's.
 */
export const listProblemsForSession = async (
  db: Querier,
  userId: string,
  sessionId: string,
  reviewId?: string,
): Promise<ReviewProblemRow[]> =>
  db
    .select()
    .from(reviewProblems)
    .innerJoin(projects, eq(projects.id, reviewProblems.projectId))
    .where(
      and(
        eq(reviewProblems.sessionId, sessionId),
        reviewId === undefined ? undefined : eq(reviewProblems.reviewId, reviewId),
        visibleToUser(db, userId),
      ),
    )
    .orderBy(asc(reviewProblems.reviewId), asc(reviewProblems.position))
    .then((rows) => rows.map((row) => row.reviewProblems))
