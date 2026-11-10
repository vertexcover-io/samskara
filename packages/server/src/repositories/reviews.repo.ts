import { and, desc, eq } from "drizzle-orm"
import type { Querier } from "../db/client.js"
import { projects, sessionReviews, sessions } from "../db/schema.js"
import { visibleToUser } from "./projects.repo.js"

export type ReviewRow = typeof sessionReviews.$inferSelect

/**
 * A finished review. The database refuses a done row without its result
 * (`sessionReviews_done_has_result_check`), so a row read with `isDone` always has one.
 */
export type DoneReviewRow = ReviewRow & {
  readonly status: "done"
  readonly outcome: string
  readonly summary: string
}

/** Only a done row is a review; waiting, running and failed rows have no result to show. */
const isDone = eq(sessionReviews.status, "done")

const asDone = (row: ReviewRow): DoneReviewRow => row as DoneReviewRow

/**
 * Latest-first like every list in the server; callers paginate above this layer. Scoped by
 * `visibleToUser` — a session's reviews are readable exactly by whoever could open the session
 * itself.
 */
export const listReviewsForSession = async (
  db: Querier,
  userId: string,
  sessionId: string,
): Promise<DoneReviewRow[]> =>
  db
    .select()
    .from(sessionReviews)
    .innerJoin(projects, eq(projects.id, sessionReviews.projectId))
    .where(and(eq(sessionReviews.sessionId, sessionId), isDone, visibleToUser(db, userId)))
    .orderBy(desc(sessionReviews.createdAt))
    .then((rows) => rows.map((row) => asDone(row.sessionReviews)))

/**
 * Whether the session has a done review from `analyzer` the viewer may read, without loading
 * it. A failed review does not count, so the batch tries that session again.
 */
export const hasReviewFrom = async (
  db: Querier,
  query: { readonly userId: string; readonly sessionId: string; readonly analyzer: string },
): Promise<boolean> => {
  const row = await db
    .select({ id: sessionReviews.id })
    .from(sessionReviews)
    .innerJoin(projects, eq(projects.id, sessionReviews.projectId))
    .where(
      and(
        eq(sessionReviews.sessionId, query.sessionId),
        eq(sessionReviews.analyzer, query.analyzer),
        isDone,
        visibleToUser(db, query.userId),
      ),
    )
    .limit(1)
  return row.length > 0
}

/** The session's project when the viewer could open the session — null when invisible or missing. */
export const visibleSessionProjectId = async (
  db: Querier,
  userId: string,
  sessionId: string,
): Promise<string | null> => {
  const row = await db
    .select({ projectId: sessions.projectId })
    .from(sessions)
    .innerJoin(projects, eq(projects.id, sessions.projectId))
    .where(and(eq(sessions.id, sessionId), visibleToUser(db, userId)))
    .limit(1)
  return row[0]?.projectId ?? null
}

export const getReview = async (db: Querier, id: string): Promise<DoneReviewRow | null> => {
  const row = await db
    .select()
    .from(sessionReviews)
    .where(and(eq(sessionReviews.id, id), isDone))
    .limit(1)
  return row[0] === undefined ? null : asDone(row[0])
}

/**
 * Replaces the same (sessionId, analyzer) pair's review — a re-review is a correction of the
 * same analysis, not a new fact.
 */
export const upsertReview = async (
  db: Querier,
  values: typeof sessionReviews.$inferInsert,
): Promise<ReviewRow> => {
  const [row] = await db
    .insert(sessionReviews)
    .values(values)
    .onConflictDoUpdate({
      target: [sessionReviews.sessionId, sessionReviews.analyzer],
      set: {
        outcome: values.outcome,
        summary: values.summary,
        signals: values.signals,
        updatedAt: new Date(),
      },
    })
    .returning()
  if (row === undefined) throw new Error("upsertReview returned no row")
  return row
}

export const sessionProjectId = async (db: Querier, sessionId: string): Promise<string | null> => {
  const row = await db
    .select({ projectId: sessions.projectId })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1)
  return row[0]?.projectId ?? null
}

export const projectNameById = async (db: Querier, id: string): Promise<string | null> => {
  const row = await db
    .select({ name: projects.name })
    .from(projects)
    .where(eq(projects.id, id))
    .limit(1)
  return row[0]?.name ?? null
}
