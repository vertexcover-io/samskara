import { MAIN_TRACK } from "@samskara/core"
import { and, desc, eq, isNotNull } from "drizzle-orm"
import type { Querier } from "../db/client.js"
import { projects, sessionReviews, sessions } from "../db/schema.js"
import { visibleToUser } from "./projects.repo.js"

export type ReviewRow = typeof sessionReviews.$inferSelect

/**
 * A review with a result. A done row always has one (`sessionReviews_done_has_result_check`);
 * a waiting, running or failed row has one when it is a re-review of a finished review.
 */
export type DoneReviewRow = ReviewRow & {
  readonly outcome: string
  readonly summary: string
}

/** A row is a review once it has a result; a re-review keeps the old one until the new one lands. */
const isDone = isNotNull(sessionReviews.outcome)

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
 * Whether the session has a review with a result from `analyzer` the viewer may read, without
 * loading it. A failed first review does not count, so Review on ticked sessions tries that
 * session again.
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

/** What a finished review writes. `reviewedThrough` is required so no writer forgets it. */
export type ReviewWrite = {
  readonly sessionId: string
  readonly projectId: string
  readonly analyzer: string
  readonly outcome: string
  readonly summary: string
  readonly signals: object
  /** The main-conversation lineNumber of the last message the review read; null when it read none. */
  readonly reviewedThrough: number | null
}

/**
 * The last line a review read: the highest main-conversation lineNumber among the messages it
 * loaded. Each subagent transcript numbers its own lines from 1, so only the main track's
 * numbers can be compared. A subagent is started and answered in the main track, so new
 * subagent work always moves this forward.
 */
export const lastLineRead = (
  messages: ReadonlyArray<{ readonly lineNumber: number; readonly trackId: string }>,
): number | null =>
  messages
    .filter((message) => message.trackId === MAIN_TRACK)
    .reduce<number | null>(
      (last, message) => (last === null || message.lineNumber > last ? message.lineNumber : last),
      null,
    )

/**
 * Replaces the same (sessionId, analyzer) pair's review — a re-review is a correction of the
 * same analysis, not a new fact. A saved review is done, whatever state the row was in.
 */
export const upsertReview = async (db: Querier, values: ReviewWrite): Promise<DoneReviewRow> => {
  const result = {
    outcome: values.outcome,
    summary: values.summary,
    signals: values.signals,
    status: "done",
    error: null,
    reviewedThrough: values.reviewedThrough,
  } as const
  const [row] = await db
    .insert(sessionReviews)
    .values({
      sessionId: values.sessionId,
      projectId: values.projectId,
      analyzer: values.analyzer,
      ...result,
    })
    .onConflictDoUpdate({
      target: [sessionReviews.sessionId, sessionReviews.analyzer],
      set: { ...result, updatedAt: new Date() },
    })
    .returning()
  if (row === undefined) throw new Error("upsertReview returned no row")
  return asDone(row)
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
