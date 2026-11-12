import {
  type DecisionRequest,
  type DecisionState,
  LEARNING_IMPACTS,
  LEARNING_PRIORITIES,
  type LearningInput,
  nextDecision,
  type ProblemInput,
  parseStory,
  returnsAtSessions,
  type WrittenLearning,
} from "@samskara/core"
import { and, asc, desc, eq, inArray, isNull, type SQL, sql } from "drizzle-orm"
import type { Db, Querier, Tx } from "../db/client.js"
import { learningRuns, learnings, reviewProblems, sessionReviews, sessions } from "../db/schema.js"
import { shownRun } from "./reviews.repo.js"

export type LearningRunRow = typeof learningRuns.$inferSelect
export type LearningRow = typeof learnings.$inferSelect

/**
 * Starts a run for the project outside the worker, or returns null when one is already waiting
 * or running there: two runs at once would read the same unmarked problems. The partial unique
 * index is the guard, so two starts racing each other cannot both win.
 */
export const startRun = async (db: Querier, projectId: string): Promise<LearningRunRow | null> => {
  const [row] = await db
    .insert(learningRuns)
    .values({ projectId, status: "running" })
    .onConflictDoNothing()
    .returning()
  return row ?? null
}

export const setHarnessRef = async (
  db: Querier,
  runId: string,
  harnessRef: string,
): Promise<void> => {
  await db.update(learningRuns).set({ harnessRef }).where(eq(learningRuns.id, runId))
}

/** How a run ended. */
export type RunOutcome =
  | { readonly status: "done" }
  | { readonly status: "failed"; readonly error: string }

export const finishRun = async (db: Querier, runId: string, result: RunOutcome): Promise<void> => {
  await db
    .update(learningRuns)
    .set({
      status: result.status,
      error: result.status === "failed" ? result.error : null,
      finishedAt: new Date(),
    })
    .where(eq(learningRuns.id, runId))
}

export const getRun = async (db: Querier, runId: string): Promise<LearningRunRow | null> => {
  const [row] = await db.select().from(learningRuns).where(eq(learningRuns.id, runId)).limit(1)
  return row ?? null
}

/** The project's most recent run, whatever its status. */
export const latestRun = async (db: Querier, projectId: string): Promise<LearningRunRow | null> => {
  const [row] = await db
    .select()
    .from(learningRuns)
    .where(eq(learningRuns.projectId, projectId))
    .orderBy(desc(learningRuns.startedAt))
    .limit(1)
  return row ?? null
}

/**
 * True when the learning was created during `run` (a `"learningRuns"` row or alias): after the
 * project's previous run finished. A project runs one fix run at a time, so whatever was created
 * since the last one ended was this run's. Not after this run's `startedAt`: a retry resets it,
 * and a fix saved by an earlier batch of a failed try would then read as older than its run.
 */
const createdDuring = (createdAt: SQL, run: SQL): SQL => sql`${createdAt} > coalesce((
  select max(prev."finishedAt") from "learningRuns" prev
  where prev."projectId" = ${run}."projectId" and prev."id" <> ${run}."id"
    and prev."finishedAt" <= ${run}."startedAt"
), '-infinity'::timestamptz)`

export type ListedRun = LearningRunRow & {
  readonly fixesCreated: number
  readonly fixesUpdated: number
}

/**
 * The project's runs, newest first, with how many fixes each created and updated: the distinct
 * learnings its problems were linked to, split by whether a learning was created during the run.
 */
export const listRuns = async (db: Querier, projectId: string): Promise<ListedRun[]> => {
  // The outer run is named in full: with no join, Drizzle renders its columns unqualified, and a
  // bare "id" inside the subquery would bind to the subquery's own row.
  const touched = sql<number>`(
    select count(distinct rp."learningId")::int from "reviewProblems" rp
    where rp."learningRunId" = "learningRuns"."id" and rp."learningId" is not null
  )`
  const created = sql<number>`(
    select count(distinct rp."learningId")::int from "reviewProblems" rp
    join "learnings" l on l."id" = rp."learningId"
    where rp."learningRunId" = "learningRuns"."id"
      and ${createdDuring(sql`l."createdAt"`, sql`"learningRuns"`)}
  )`
  const rows = await db
    .select({ run: learningRuns, touched, created })
    .from(learningRuns)
    .where(eq(learningRuns.projectId, projectId))
    .orderBy(desc(learningRuns.startedAt))
  return rows.map((row) => ({
    ...row.run,
    fixesCreated: row.created,
    fixesUpdated: row.touched - row.created,
  }))
}

/** How many of the project's session reviews are waiting or running: what a waiting fix run waits on. */
export const reviewsWaiting = async (db: Querier, projectId: string): Promise<number> => {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(sessionReviews)
    .where(
      and(
        eq(sessionReviews.projectId, projectId),
        inArray(sessionReviews.status, ["waiting", "running"]),
      ),
    )
  return row?.count ?? 0
}

/** The project's fix run that is waiting or running; at most one exists. */
export const openRun = async (db: Querier, projectId: string): Promise<LearningRunRow | null> => {
  const [row] = await db
    .select()
    .from(learningRuns)
    .where(
      and(
        eq(learningRuns.projectId, projectId),
        inArray(learningRuns.status, ["waiting", "running"]),
      ),
    )
    .limit(1)
  return row ?? null
}

const problemColumns = {
  id: reviewProblems.id,
  reviewId: reviewProblems.reviewId,
  sessionId: reviewProblems.sessionId,
  title: reviewProblems.title,
  class: reviewProblems.class,
  severity: reviewProblems.severity,
  severityReason: reviewProblems.severityReason,
  fixType: reviewProblems.fixType,
  description: reviewProblems.description,
  learning: reviewProblems.learning,
  evidence: reviewProblems.evidence,
}

// The columns' check constraints hold the same lists as the core types.
const asProblem = (row: Record<keyof typeof problemColumns, unknown>): ProblemInput =>
  row as ProblemInput

/**
 * The project's problems that no run has considered yet, from runs a session page shows
 * (`shownRun`), oldest first. `limit` is the batch
 * size: a first run over a long history works through it a batch at a time.
 */
export const unmarkedProblems = async (
  db: Querier,
  projectId: string,
  limit: number,
): Promise<ProblemInput[]> =>
  db
    .select(problemColumns)
    .from(reviewProblems)
    .innerJoin(sessionReviews, eq(sessionReviews.id, reviewProblems.reviewId))
    .where(
      and(
        eq(reviewProblems.projectId, projectId),
        isNull(reviewProblems.learningRunId),
        shownRun(sql`"sessionReviews"`),
      ),
    )
    .orderBy(
      asc(reviewProblems.createdAt),
      asc(reviewProblems.reviewId),
      asc(reviewProblems.position),
    )
    .limit(limit)
    .then((rows) => rows.map(asProblem))

/** What agent 1 is shown of each learning so far: enough to tell whether a cause is the same. */
export const learningsForGrouping = async (
  db: Querier,
  projectId: string,
): Promise<Array<Pick<LearningInput, "id" | "title" | "cause">>> =>
  db
    .select({ id: learnings.id, title: learnings.title, cause: learnings.cause })
    .from(learnings)
    .where(eq(learnings.projectId, projectId))
    .orderBy(asc(learnings.createdAt))

/** Learnings in full, each with every problem already linked to it, for agent 2. */
export const learningsWithProblems = async (
  db: Querier,
  ids: ReadonlyArray<string>,
): Promise<
  Array<LearningInput & { readonly updatedByRunId: string; readonly problems: ProblemInput[] }>
> => {
  if (ids.length === 0) return []
  const rows = await db
    .select()
    .from(learnings)
    .where(inArray(learnings.id, [...ids]))
  const linked = await db
    .select({ ...problemColumns, learningId: reviewProblems.learningId })
    .from(reviewProblems)
    .where(inArray(reviewProblems.learningId, [...ids]))
    .orderBy(asc(reviewProblems.createdAt))
  return rows.map((row) => ({
    ...(row as LearningInput),
    story: parseStory(row.story),
    updatedByRunId: row.updatedByRunId,
    problems: linked.filter((problem) => problem.learningId === row.id).map(asProblem),
  }))
}

/**
 * What an excerpt needs from each review: its session, and the record order it numbered msg-N
 * by (`signals.run.recordIds`). A review saved before that order was kept has none.
 */
export const reviewSessions = async (
  db: Querier,
  reviewIds: ReadonlyArray<string>,
): Promise<
  Array<{
    readonly reviewId: string
    readonly sessionId: string
    readonly projectId: string
    readonly title: string | null
    readonly source: string
    readonly recordIds: ReadonlyArray<string | null> | null
  }>
> => {
  if (reviewIds.length === 0) return []
  const rows = await db
    .select({
      reviewId: sessionReviews.id,
      sessionId: sessionReviews.sessionId,
      projectId: sessions.projectId,
      title: sessions.title,
      source: sessions.source,
      recordIds: sql<Array<string | null> | null>`${sessionReviews.signals}->'run'->'recordIds'`,
    })
    .from(sessionReviews)
    .innerJoin(sessions, eq(sessions.id, sessionReviews.sessionId))
    .where(inArray(sessionReviews.id, [...reviewIds]))
  return rows.map((row) => ({
    ...row,
    recordIds: Array.isArray(row.recordIds) ? row.recordIds : null,
  }))
}

export type SavedGroup = {
  readonly cause: string
  /** The learning this group joined, or null when it is new. */
  readonly learningId: string | null
  readonly problemIds: ReadonlyArray<string>
  readonly answer: WrittenLearning
}

/** What saving did with one group, in group order: for the run's log. */
export type SavedOutcome = {
  /** `skipped`: none of its problems were left to save (a review was redone mid-run). */
  readonly action: "created" | "updated" | "dropped" | "skipped"
  readonly learningId: string | null
  /** The problems actually marked. */
  readonly problemIds: ReadonlyArray<string>
}

/**
 * Reopens a skipped fix once it has been seen in enough more sessions since its last skip
 * (`returnsAtSessions`): 10 after the first skip, 20 after the second. Nobody decided it, so
 * `decidedBy` is cleared; the skip count stays. Counted after the batch's problems are linked,
 * so they count.
 */
const returnIfSeenEnough = async (tx: Tx, learningId: string): Promise<void> => {
  const [row] = await tx
    .select({
      decision: learnings.decision,
      skipCount: learnings.skipCount,
      sessionsAtSkip: learnings.sessionsAtSkip,
    })
    .from(learnings)
    .where(eq(learnings.id, learningId))
    .for("update")
  const at =
    row === undefined ? null : returnsAtSessions(row as Parameters<typeof returnsAtSessions>[0])
  if (at === null || (await sessionCountOf(tx, learningId)) < at) return
  await tx
    .update(learnings)
    .set({ decision: "open", decidedAt: new Date(), decidedBy: null })
    .where(eq(learnings.id, learningId))
}

/**
 * One batch's result, all at once: new learnings created, joined ones rewritten, and every
 * problem the batch read marked with the run, linked to its learning when it has one. A
 * dropped group makes no learning; its problems are marked and nothing else.
 */
export const saveBatch = async (
  db: Db,
  input: {
    readonly runId: string
    readonly projectId: string
    readonly groups: ReadonlyArray<SavedGroup>
  },
): Promise<SavedOutcome[]> =>
  db.transaction(async (tx) => {
    const outcomes: SavedOutcome[] = []
    for (const group of input.groups) {
      // A review redone during the run replaced its problems with new rows, and another run
      // may not have; only rows still here and still unmarked are this batch's to save. A group
      // with none left makes no learning, rather than an empty one.
      const present =
        group.problemIds.length === 0
          ? []
          : await tx
              .select({ id: reviewProblems.id })
              .from(reviewProblems)
              .where(
                and(
                  inArray(reviewProblems.id, [...group.problemIds]),
                  isNull(reviewProblems.learningRunId),
                ),
              )
      if (present.length === 0) {
        outcomes.push({ action: "skipped", learningId: null, problemIds: [] })
        continue
      }
      let learningId: string | null = null
      if (group.answer.verdict === "learning") {
        const { verdict: _, ...fields } = group.answer
        if (group.learningId === null) {
          const [row] = await tx
            .insert(learnings)
            .values({
              ...fields,
              projectId: input.projectId,
              cause: group.cause,
              updatedByRunId: input.runId,
            })
            .returning({ id: learnings.id })
          learningId = row?.id ?? null
        } else {
          await tx
            .update(learnings)
            .set({ ...fields, updatedByRunId: input.runId, updatedAt: new Date() })
            .where(eq(learnings.id, group.learningId))
          learningId = group.learningId
        }
      }
      const problemIds = present.map((row) => row.id)
      await tx
        .update(reviewProblems)
        .set({ learningRunId: input.runId, learningId })
        .where(inArray(reviewProblems.id, problemIds))
      // A joined fix may be a skipped one this batch has now seen in enough more sessions.
      if (learningId !== null && group.learningId !== null) await returnIfSeenEnough(tx, learningId)
      outcomes.push({
        action:
          group.answer.verdict === "drop"
            ? "dropped"
            : group.learningId === null
              ? "created"
              : "updated",
        learningId,
        problemIds,
      })
    }
    return outcomes
  })

export type ListedLearning = LearningRow & {
  readonly problemCount: number
  readonly sessionCount: number
  /** When its earliest and latest problem happened (`reviewProblems.seenAt`); null with no problems. */
  readonly firstSeenAt: Date | null
  readonly lastSeenAt: Date | null
  /** How many sessions had one of its problems in the last 7 days. */
  readonly sessionsLast7Days: number
  /** With a run filter: whether that run created this learning or updated it; otherwise null. */
  readonly runMark: "new" | "updated" | null
}

/** Which of a project's learnings to list. Every field narrows; an empty filter lists them all. */
export type LearningFilter = {
  readonly fixType?: string | undefined
  /** Only learnings with a problem that happened at or after this instant… */
  readonly seenFrom?: Date | undefined
  /** …and before this one. */
  readonly seenBefore?: Date | undefined
  /** Only learnings this run touched: one of its problems is linked to them. */
  readonly runId?: string | undefined
}

/**
 * The filter as conditions on `learnings`. The date window is an `exists` over the learning's
 * problems rather than a condition on the joined rows, so a fix it keeps still counts all its
 * problems and sessions in this project, not only the ones inside the window. The subquery aliases its tables
 * because the outer query joins `sessions` too. A session moved to another project matches
 * neither, so the dates never show when a project the reader may not see was active.
 */
const filterConditions = (filter: LearningFilter): SQL[] => {
  const conditions: SQL[] = []
  if (filter.fixType !== undefined) conditions.push(eq(learnings.fixType, filter.fixType))
  if (filter.runId !== undefined)
    conditions.push(sql`exists (
      select 1 from "reviewProblems" rp
      where rp."learningId" = ${learnings.id} and rp."learningRunId" = ${filter.runId}
    )`)
  if (filter.seenFrom !== undefined || filter.seenBefore !== undefined) {
    const from =
      filter.seenFrom === undefined
        ? sql``
        : sql` and rp."seenAt" >= ${filter.seenFrom.toISOString()}::timestamptz`
    const before =
      filter.seenBefore === undefined
        ? sql``
        : sql` and rp."seenAt" < ${filter.seenBefore.toISOString()}::timestamptz`
    conditions.push(sql`exists (
      select 1 from "reviewProblems" rp
      join "sessions" s on s."id" = rp."sessionId" and s."projectId" = ${learnings.projectId}
      where rp."learningId" = ${learnings.id}${from}${before}
    )`)
  }
  return conditions
}

const asDate = (value: string | null): Date | null => (value === null ? null : new Date(value))

/** High first: a priority's place in `LEARNING_PRIORITIES`. */
const PRIORITY_ORDER = sql`array_position(${sql.raw(`array[${LEARNING_PRIORITIES.map((p) => `'${p}'`).join(", ")}]`)}::text[], ${learnings.priority})`

/** Worst impact first; a learning with none (written before impact existed) sorts last. */
const IMPACT_ORDER = sql`array_position(${sql.raw(`array[${LEARNING_IMPACTS.map((p) => `'${p}'`).join(", ")}]`)}::text[], ${learnings.impact}) nulls last`

/**
 * The project's learnings: high priority first, then worst impact, then most sessions. A
 * learning is seen when one of its problems happened (`reviewProblems.seenAt`), not when the
 * problem's session was last active: a session still in use today can hold a problem from
 * weeks ago, and its activity would make every fix in it look current.
 */
export const listLearnings = async (
  db: Querier,
  projectId: string,
  filter: LearningFilter = {},
): Promise<ListedLearning[]> => {
  // Counted through the joined session, so a session moved to another project leaves the counts
  // as it leaves the seen dates, and a card's count and seen line describe the same sessions.
  const problemCount = sql<number>`count(${sessions.id})::int`
  const sessionCount = sql<number>`count(distinct ${sessions.id})::int`
  // Only problems whose session is still in this project, like the counts above.
  const inProject = sql`${sessions.id} is not null`
  const firstSeenAt = sql<string | null>`min(${reviewProblems.seenAt}) filter (where ${inProject})`
  const lastSeenAt = sql<string | null>`max(${reviewProblems.seenAt}) filter (where ${inProject})`
  const sessionsLast7Days = sql<number>`(count(distinct ${sessions.id}) filter (where ${reviewProblems.seenAt} >= now() - interval '7 days'))::int`
  const runMark =
    filter.runId === undefined
      ? sql<"new" | "updated" | null>`null`
      : sql<"new" | "updated">`(
          select case when ${createdDuring(sql`${learnings.createdAt}`, sql`r`)} then 'new' else 'updated' end
          from "learningRuns" r where r."id" = ${filter.runId}
        )`
  const rows = await db
    .select({
      learning: learnings,
      problemCount,
      sessionCount,
      firstSeenAt,
      lastSeenAt,
      sessionsLast7Days,
      runMark,
    })
    .from(learnings)
    .leftJoin(reviewProblems, eq(reviewProblems.learningId, learnings.id))
    .leftJoin(
      sessions,
      and(eq(sessions.id, reviewProblems.sessionId), eq(sessions.projectId, learnings.projectId)),
    )
    .where(and(eq(learnings.projectId, projectId), ...filterConditions(filter)))
    .groupBy(learnings.id)
    .orderBy(
      PRIORITY_ORDER,
      IMPACT_ORDER,
      desc(sessionCount),
      desc(problemCount),
      asc(learnings.createdAt),
    )
  return rows.map((row) => ({
    ...row.learning,
    problemCount: row.problemCount,
    sessionCount: row.sessionCount,
    firstSeenAt: asDate(row.firstSeenAt),
    lastSeenAt: asDate(row.lastSeenAt),
    sessionsLast7Days: row.sessionsLast7Days,
    runMark: row.runMark,
  }))
}

export const getLearning = async (db: Querier, id: string): Promise<LearningRow | null> => {
  const [row] = await db.select().from(learnings).where(eq(learnings.id, id)).limit(1)
  return row ?? null
}

/**
 * The fix's session count as its card shows it: the distinct sessions behind its problems that
 * are still in the fix's project, so a session moved elsewhere is not counted.
 */
export const sessionCountOf = async (db: Querier, learningId: string): Promise<number> => {
  const [row] = await db
    .select({ count: sql<number>`count(distinct ${sessions.id})::int` })
    .from(reviewProblems)
    .innerJoin(learnings, eq(learnings.id, reviewProblems.learningId))
    .innerJoin(
      sessions,
      and(eq(sessions.id, reviewProblems.sessionId), eq(sessions.projectId, learnings.projectId)),
    )
    .where(eq(reviewProblems.learningId, learningId))
  return row?.count ?? 0
}

/**
 * Sets the decision `by` asks for (`nextDecision`). Returns the row, or null when it is gone.
 * The row is locked while its session count is read, so a fix run saving to it waits.
 */
export const setDecision = async (
  db: Db,
  id: string,
  request: DecisionRequest,
  by: string,
): Promise<LearningRow | null> =>
  db.transaction(async (tx) => {
    const [row] = await tx.select().from(learnings).where(eq(learnings.id, id)).for("update")
    if (row === undefined) return null
    const current = row as LearningRow & DecisionState
    const next = nextDecision(current, request, {
      userId: by,
      at: new Date(),
      sessionCount: await sessionCountOf(tx, id),
    })
    if (next === current) return row
    const { decision, decidedAt, decidedBy, rejectReason, skipCount, sessionsAtSkip } = next
    const [updated] = await tx
      .update(learnings)
      .set({ decision, decidedAt, decidedBy, rejectReason, skipCount, sessionsAtSkip })
      .where(eq(learnings.id, id))
      .returning()
    return updated ?? null
  })

/** The problems behind a learning, with their session and evidence, so a reader can check it. */
export const problemsOfLearning = async (db: Querier, learningId: string) =>
  db
    .select({ ...problemColumns, projectId: reviewProblems.projectId })
    .from(reviewProblems)
    .where(eq(reviewProblems.learningId, learningId))
    .orderBy(asc(reviewProblems.createdAt))
