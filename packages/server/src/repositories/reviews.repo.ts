import { MAIN_TRACK } from "@samskara/core"
import { and, desc, eq, type SQL, sql } from "drizzle-orm"
import type { Querier } from "../db/client.js"
import { projects, sessionReviews, sessions } from "../db/schema.js"
import { visibleToUser } from "./projects.repo.js"
import { deleteReaderReplies } from "./readerReplies.repo.js"

export type ReviewRow = typeof sessionReviews.$inferSelect

/** A done review: it always has a result (`sessionReviews_done_has_result_check`). */
export type DoneReviewRow = ReviewRow & {
  readonly outcome: string
  readonly summary: string
}

const isDone = eq(sessionReviews.status, "done")

const asDone = (row: ReviewRow): DoneReviewRow => row as DoneReviewRow

/**
 * The chain rule, for a review row aliased `alias` in raw SQL: the row is done and no newer
 * done full run of the same session and analyzer exists. That keeps the latest done full run
 * and every done new-part run after it, and hides older runs, which stay in the database.
 * `createdAt` orders runs: only one per session is ever waiting or running, so they finish in
 * the order they were queued.
 */
export const shownRun = (alias: SQL): SQL => sql`(${alias}."status" = 'done' and not exists (
  select 1 from "sessionReviews" newer
  where newer."sessionId" = ${alias}."sessionId"
    and newer."analyzer" = ${alias}."analyzer"
    and newer."status" = 'done'
    and not newer."newPartOnly"
    and newer."createdAt" > ${alias}."createdAt"
))`

/**
 * Message types that carry no conversation: never "new" on their own, so a session that only
 * gained token reports or turn markers has nothing to review. `splitNewPart` applies the same
 * list, so what counts as new here is what a new-part run reads as new.
 */
export const SILENT_MESSAGE_TYPES: ReadonlyArray<string> = ["turnEvent", "custom", "usage"]

/** `SILENT_MESSAGE_TYPES` as a SQL list, for `not in`. */
export const SILENT_TYPES = sql`(${sql.join(
  SILENT_MESSAGE_TYPES.map((type) => sql`${type}`),
  sql`, `,
)})`

/**
 * True when session `sessionId` has a message newer than run `run` read: a later `timestamp`
 * than the run's `lastMessageId` message in any track, or no timestamp and stored after the
 * run finished (`updatedAt`). A run that read nothing makes every message new. `run` is a
 * review row alias in raw SQL. Time, not line number: each subagent numbers its own lines.
 */
export const newMessagesAfter = (sessionId: SQL, run: SQL): SQL => sql`exists (
  select 1 from "messages" nm
  where nm."sessionId" = ${sessionId}
    and nm."msgType" not in ${SILENT_TYPES}
    and ${readAfter(sql`nm`, run)}
)`

/** Whether message `message` (a raw SQL alias) came after what run `run` read; see `newMessagesAfter`. */
const readAfter = (message: SQL, run: SQL): SQL => sql`(
  (${message}."timestamp" is not null and ${message}."timestamp" > coalesce(
    (select lm."timestamp" from "messages" lm where lm."id" = ${run}."lastMessageId"),
    '-infinity'::timestamptz))
  or (${message}."timestamp" is null and ${message}."createdAt" > ${run}."updatedAt")
)`

/**
 * True when session `sessionId` has at least `atLeast` messages the person typed after what run
 * `run` read: user messages of the main conversation, leaving out injected ones (a `subType`,
 * or `isMeta`) and subagent prompts. Stops counting at `atLeast`.
 */
export const newUserMessagesAfter = (sessionId: SQL, run: SQL, atLeast: number): SQL => sql`(
  select count(*) from (
    select 1 from "messages" um
    where um."sessionId" = ${sessionId}
      and um."msgType" = 'message' and um."role" = 'user' and um."trackId" = ${MAIN_TRACK}
      and um."subType" is null
      and coalesce(um."details"->>'isMeta', 'false') <> 'true'
      and ${readAfter(sql`um`, run)}
    limit ${atLeast}
  ) typed
) >= ${atLeast}`

/** The session's newest done run of `analyzer`: the newest run of its shown chain. */
export const latestDoneRun = async (
  db: Querier,
  sessionId: string,
  analyzer: string,
): Promise<DoneReviewRow | null> => {
  const [row] = await db
    .select()
    .from(sessionReviews)
    .where(
      and(eq(sessionReviews.sessionId, sessionId), eq(sessionReviews.analyzer, analyzer), isDone),
    )
    .orderBy(desc(sessionReviews.createdAt))
    .limit(1)
  return row === undefined ? null : asDone(row)
}

/** Whether the session has messages newer than run `runId` read. */
export const hasNewMessagesSince = async (
  db: Querier,
  sessionId: string,
  runId: string,
): Promise<boolean> => {
  const rows = await db.execute<{ yes: boolean }>(sql`
    select ${newMessagesAfter(sql`${sessionId}`, sql`r`)} as "yes"
    from "sessionReviews" r where r."id" = ${runId}`)
  return rows[0]?.yes === true
}

/** The shown chain of a session, newest first, with no viewer check: for the worker. */
export const shownRunsOf = async (
  db: Querier,
  sessionId: string,
  analyzer: string,
): Promise<DoneReviewRow[]> =>
  db
    .select()
    .from(sessionReviews)
    .where(
      and(
        eq(sessionReviews.sessionId, sessionId),
        eq(sessionReviews.analyzer, analyzer),
        shownRun(sql`"sessionReviews"`),
      ),
    )
    .orderBy(desc(sessionReviews.createdAt))
    .then((rows) => rows.map(asDone))

/**
 * The session's shown runs (`shownRun`), newest first: the newest supplies the outcome and
 * summary a page shows. Scoped by `visibleToUser` — a session's reviews are readable exactly
 * by whoever could open the session itself.
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
    .where(
      and(
        eq(sessionReviews.sessionId, sessionId),
        shownRun(sql`"sessionReviews"`),
        visibleToUser(db, userId),
      ),
    )
    .orderBy(desc(sessionReviews.createdAt))
    .then((rows) => rows.map((row) => asDone(row.sessionReviews)))

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

/** What a finished run writes onto its own row. `lastMessageId` is required so no writer forgets it. */
export type ReviewResult = {
  readonly outcome: string
  readonly summary: string
  readonly signals: object
  /** The message the run read with the latest timestamp; null when it read none. */
  readonly lastMessageId: string | null
}

/**
 * The message a run read last in time: the latest `timestamp` across every track, since each
 * subagent numbers its own lines from 1 and only time compares tracks. With no timestamped
 * message, the last main-track line read. Null when it read nothing.
 */
export const lastMessageRead = (
  messages: ReadonlyArray<{
    readonly id: string
    readonly lineNumber: number
    readonly trackId: string
    readonly timestamp: string | null
  }>,
): string | null => {
  const timed = messages.flatMap((message) =>
    message.timestamp === null ? [] : [{ id: message.id, at: Date.parse(message.timestamp) }],
  )
  if (timed.length > 0)
    return timed.reduce((last, message) => (message.at >= last.at ? message : last)).id
  const main = messages.filter((message) => message.trackId === MAIN_TRACK)
  if (main.length === 0) return null
  return main.reduce((last, message) => (message.lineNumber >= last.lineNumber ? message : last)).id
}

/**
 * Writes a run's result onto its own row and marks it done. Only that row changes: an earlier
 * run of the same session is history and is never overwritten. A done run is not tried again,
 * so the replies its readers kept for a retry are dropped, in the caller's transaction.
 */
export const finishReview = async (
  db: Querier,
  id: string,
  values: ReviewResult,
): Promise<DoneReviewRow> => {
  const [row] = await db
    .update(sessionReviews)
    .set({ ...values, status: "done", error: null, updatedAt: new Date() })
    .where(eq(sessionReviews.id, id))
    .returning()
  if (row === undefined) throw new Error(`finishReview: no review ${id}`)
  await deleteReaderReplies(db, [row.id])
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
