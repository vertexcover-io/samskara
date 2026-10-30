import { and, desc, eq } from "drizzle-orm"
import type { Querier } from "../db/client.js"
import { projects, sessionReviews, sessions } from "../db/schema.js"
import { visibleToUser } from "./projects.repo.js"

export type ReviewRow = typeof sessionReviews.$inferSelect

/**
 * Latest-first like every list in the server; callers paginate above this layer. Scoped by
 * `visibleToUser` — a session's reviews are readable exactly by whoever could open the session
 * itself.
 */
export const listReviewsForSession = async (
  db: Querier,
  userId: string,
  sessionId: string,
): Promise<ReviewRow[]> =>
  db
    .select()
    .from(sessionReviews)
    .innerJoin(projects, eq(projects.id, sessionReviews.projectId))
    .where(and(eq(sessionReviews.sessionId, sessionId), visibleToUser(db, userId)))
    .orderBy(desc(sessionReviews.createdAt))
    .then((rows) => rows.map((row) => row.sessionReviews))

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

export const getReview = async (db: Querier, id: string): Promise<ReviewRow | null> => {
  const row = await db.select().from(sessionReviews).where(eq(sessionReviews.id, id)).limit(1)
  return row[0] ?? null
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
        friction: values.friction,
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
