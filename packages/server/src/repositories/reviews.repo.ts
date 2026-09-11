import { and, desc, eq, type SQL, type SQLWrapper, sql } from "drizzle-orm"
import type { Db, Querier } from "../db/client.js"
import { learningSessions, learnings, projects, sessionReviews, sessions } from "../db/schema.js"
import { visibleToUser } from "./projects.repo.js"

export type ReviewRow = typeof sessionReviews.$inferSelect
export type LearningRow = typeof learnings.$inferSelect

/**
 * Latest-first like every list in the server; callers paginate above this layer. Scoped by the
 * same `visibleToUser` join as `listLearnings` — a session's reviews are readable exactly by
 * whoever could open the session itself.
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
 * same analysis, not a new fact. The learnings it produced keep their rows via the SET NULL
 * on sourceReviewId, so a lesson outlives the review that first spotted it.
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

export type LearningFilter = {
  readonly projectId?: string
  readonly audience?: "agent" | "human"
  readonly status?: "candidate" | "accepted" | "superseded"
}

/**
 * Every learning the viewer can see: learnings inherit their project's visibility, exactly
 * like sessions do — a query with no project filter still only returns projects the viewer
 * could open. `canRead` is not re-checked per row; `visibleToUser` in the join is the check.
 */
export const listLearnings = async (
  db: Querier,
  userId: string,
  filter: LearningFilter = {},
): Promise<LearningRow[]> => {
  const conditions = [
    filter.projectId === undefined ? undefined : eq(learnings.projectId, filter.projectId),
    filter.audience === undefined ? undefined : eq(learnings.audience, filter.audience),
    filter.status === undefined ? undefined : eq(learnings.status, filter.status),
    visibleToUser(db, userId),
  ].filter((condition) => condition !== undefined)
  return db
    .select()
    .from(learnings)
    .innerJoin(projects, eq(projects.id, learnings.projectId))
    .where(and(...conditions))
    .orderBy(desc(learnings.lastSeenAt))
    .then((rows) => rows.map((row) => row.learnings))
}

/**
 * Lessons whose current `sourceReviewId` points at a review of this session. Honest about the
 * semantics: an upsert-by-fingerprint moves sourceReviewId to the newest review, so this lists
 * lessons whose *latest* provenance is here — a lesson first seen in this session but re-seen
 * elsewhere no longer appears. Acceptable for increment 1.
 */
export const listLearningsForSession = async (
  db: Querier,
  userId: string,
  sessionId: string,
): Promise<LearningRow[]> =>
  db
    .select()
    .from(learnings)
    .innerJoin(sessionReviews, eq(sessionReviews.id, learnings.sourceReviewId))
    .innerJoin(projects, eq(projects.id, learnings.projectId))
    .where(and(eq(sessionReviews.sessionId, sessionId), visibleToUser(db, userId)))
    .orderBy(desc(learnings.lastSeenAt))
    .then((rows) => rows.map((row) => row.learnings))

export type CommonLearningRow = {
  readonly fingerprint: string
  readonly audience: string
  readonly category: string
  readonly title: string
  readonly detail: string
  readonly status: string
  readonly projectCount: number
  readonly totalOccurrences: number
  readonly projectNames: ReadonlyArray<string>
}

/**
 * The cross-project view: same fingerprint in two or more projects the viewer can see, one
 * row per fingerprint with the project names attached. Tool-generic lessons ("Bash failed
 * N times in a row") are not project knowledge, so this is where they become visible as
 * patterns rather than as N separate rows. Aggregated at read time on purpose — no
 * org-level copy of the data to drift out of sync.
 */
export const listCommonLearnings = async (
  db: Querier,
  userId: string,
): Promise<CommonLearningRow[]> => {
  const rows = await db
    .select({
      fingerprint: learnings.fingerprint,
      audience: learnings.audience,
      category: learnings.category,
      title: sql<string>`min(${learnings.title})`,
      detail: sql<string>`min(${learnings.detail})`,
      status: sql<string>`min(${learnings.status})`,
      projectCount: sql<number>`count(distinct ${learnings.projectId})::int`,
      totalOccurrences: sql<number>`sum(${learnings.occurrenceCount})::int`,
      projectNames: sql<
        ReadonlyArray<string>
      >`array_agg(distinct ${projects.name} order by ${projects.name})`,
    })
    .from(learnings)
    .innerJoin(projects, eq(projects.id, learnings.projectId))
    .where(visibleToUser(db, userId))
    .groupBy(learnings.fingerprint, learnings.audience, learnings.category)
    .having(sql`count(distinct ${learnings.projectId}) >= 2`)
    .orderBy(
      desc(sql`count(distinct ${learnings.projectId})`),
      desc(sql`sum(${learnings.occurrenceCount})`),
    )
  return rows
}

export const getLearning = async (db: Querier, id: string): Promise<LearningRow | null> => {
  const row = await db.select().from(learnings).where(eq(learnings.id, id)).limit(1)
  return row[0] ?? null
}

/**
 * The largest count embedded in a title — "Bash failed 9 times in a row" is 9, a title
 * with no digits is 0. Magnitude, not freshness, decides which title a learning keeps:
 * titles embed the session's own count, so blindly taking the latest would let a mild
 * re-sighting erase the worst one on record. Ties keep the incumbent.
 */
const titleMagnitude = (title: SQLWrapper | string): SQL =>
  sql`(select coalesce(max(digits[1]::int), 0) from regexp_matches(${title}, '(\\d+)', 'g') as digits)`

/**
 * Upsert by (projectId, fingerprint): a re-seen lesson refreshes its detail and provenance
 * rather than stacking a near-duplicate — the fingerprint already ignores counts for exactly
 * this reason. occurrenceCount counts DISTINCT SESSIONS: the bump is conditioned on the
 * source review's session not being in learningSessions yet, and the pair is recorded right
 * after, so re-reviewing the same session (even via a different analyzer) is idempotent.
 * Both the counter and lastSeenAt move only on a genuinely new sighting; the title switches
 * only to a strictly larger embedded magnitude.
 */
export const upsertLearning = async (
  db: Db,
  values: typeof learnings.$inferInsert,
): Promise<LearningRow> => {
  if (values.sourceReviewId === undefined || values.sourceReviewId === null)
    throw new Error(
      "upsertLearning requires sourceReviewId to attribute the occurrence to a session",
    )
  const review = await getReview(db, values.sourceReviewId)
  if (review === null) throw new Error(`upsertLearning: review ${values.sourceReviewId} not found`)

  return db.transaction(async (tx) => {
    // True when the session already contributed this learning — table-qualified learnings
    // columns read the existing row inside ON CONFLICT DO UPDATE.
    const alreadyCounted = sql`exists (
      select 1 from ${learningSessions}
      where ${learningSessions.learningId} = ${learnings.id}
        and ${learningSessions.sessionId} = ${review.sessionId}
    )`
    const [row] = await tx
      .insert(learnings)
      .values(values)
      .onConflictDoUpdate({
        target: [learnings.projectId, learnings.fingerprint],
        set: {
          title: sql`case when ${titleMagnitude(values.title)} > ${titleMagnitude(learnings.title)}
            then ${values.title} else ${learnings.title} end`,
          detail: values.detail,
          evidence: values.evidence,
          sourceReviewId: values.sourceReviewId,
          occurrenceCount: sql`${learnings.occurrenceCount} + (case when ${alreadyCounted} then 0 else 1 end)`,
          lastSeenAt: sql`case when ${alreadyCounted} then ${learnings.lastSeenAt} else now() end`,
          updatedAt: new Date(),
        },
      })
      .returning()
    if (row === undefined) throw new Error("upsertLearning returned no row")
    await tx
      .insert(learningSessions)
      .values({ learningId: row.id, sessionId: review.sessionId })
      .onConflictDoNothing()
    return row
  })
}

export const setLearningStatus = async (
  db: Querier,
  id: string,
  status: "candidate" | "accepted" | "superseded",
): Promise<LearningRow | null> => {
  const [row] = await db
    .update(learnings)
    .set({ status, updatedAt: new Date() })
    .where(eq(learnings.id, id))
    .returning()
  return row ?? null
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
