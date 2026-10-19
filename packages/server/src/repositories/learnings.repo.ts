import {
  LEARNING_PRIORITIES,
  type LearningInput,
  type ProblemInput,
  type WrittenLearning,
} from "@samskara/core"
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, notExists, sql } from "drizzle-orm"
import type { Db, Querier } from "../db/client.js"
import {
  learningRuns,
  learnings,
  projects,
  reviewProblems,
  sessionReviews,
  sessions,
} from "../db/schema.js"

export type LearningRunRow = typeof learningRuns.$inferSelect
export type LearningRow = typeof learnings.$inferSelect

/**
 * Starts a run for the org, or returns null when one is already running there: two runs at
 * once would read the same unmarked problems. The partial unique index is the guard, so two
 * starts racing each other cannot both win.
 */
export const startRun = async (db: Querier, orgId: string): Promise<LearningRunRow | null> => {
  const [row] = await db.insert(learningRuns).values({ orgId }).onConflictDoNothing().returning()
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

/**
 * A run lives in the server process; one still `running` when the server starts again was cut
 * off by the restart. Failing it frees the org for the next run, and its problems were never
 * marked, so that run reads them again.
 */
export const failInterruptedRuns = async (db: Querier): Promise<number> => {
  const rows = await db
    .update(learningRuns)
    .set({ status: "failed", error: "the server stopped during the run", finishedAt: new Date() })
    .where(eq(learningRuns.status, "running"))
    .returning({ id: learningRuns.id })
  return rows.length
}

export const getRun = async (db: Querier, runId: string): Promise<LearningRunRow | null> => {
  const [row] = await db.select().from(learningRuns).where(eq(learningRuns.id, runId)).limit(1)
  return row ?? null
}

/**
 * Orgs with problems no run has read whose last run started before `since` (or that never had
 * one) — the ones the weekly schedule starts a run for. A failed run counts: it is retried a
 * week later, not every hour.
 */
export const orgsDueForRun = async (db: Querier, since: Date): Promise<string[]> =>
  db
    .selectDistinct({ orgId: projects.ownerOrgId })
    .from(reviewProblems)
    .innerJoin(projects, eq(projects.id, reviewProblems.projectId))
    .where(
      and(
        isNull(reviewProblems.learningRunId),
        isNotNull(projects.ownerOrgId),
        notExists(
          db
            .select({ one: sql`1` })
            .from(learningRuns)
            .where(
              and(eq(learningRuns.orgId, projects.ownerOrgId), gt(learningRuns.startedAt, since)),
            ),
        ),
      ),
    )
    .then((rows) => rows.flatMap((row) => (row.orgId === null ? [] : [row.orgId])))

/** The org's most recent run, whatever its status. */
export const latestRun = async (db: Querier, orgId: string): Promise<LearningRunRow | null> => {
  const [row] = await db
    .select()
    .from(learningRuns)
    .where(eq(learningRuns.orgId, orgId))
    .orderBy(desc(learningRuns.startedAt))
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
 * Problems in the org's projects that no run has considered yet, oldest first. `limit` is the
 * batch size: a first run over a long history works through it a batch at a time.
 */
export const unmarkedProblems = async (
  db: Querier,
  orgId: string,
  limit: number,
): Promise<ProblemInput[]> =>
  db
    .select(problemColumns)
    .from(reviewProblems)
    .innerJoin(projects, eq(projects.id, reviewProblems.projectId))
    .where(and(eq(projects.ownerOrgId, orgId), isNull(reviewProblems.learningRunId)))
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
  orgId: string,
): Promise<Array<Pick<LearningInput, "id" | "title" | "cause">>> =>
  db
    .select({ id: learnings.id, title: learnings.title, cause: learnings.cause })
    .from(learnings)
    .where(eq(learnings.orgId, orgId))
    .orderBy(asc(learnings.createdAt))

/** Learnings in full, each with every problem already linked to it, for agent 2. */
export const learningsWithProblems = async (
  db: Querier,
  ids: ReadonlyArray<string>,
): Promise<Array<LearningInput & { readonly problems: ProblemInput[] }>> => {
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
 * One batch's result, all at once: new learnings created, joined ones rewritten, and every
 * problem the batch read marked with the run, linked to its learning when it has one. A
 * dropped group makes no learning; its problems are marked and nothing else.
 */
export const saveBatch = async (
  db: Db,
  input: {
    readonly runId: string
    readonly orgId: string
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
              orgId: input.orgId,
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
}

/** High first: a priority's place in `LEARNING_PRIORITIES`. */
const PRIORITY_ORDER = sql`array_position(${sql.raw(`array[${LEARNING_PRIORITIES.map((p) => `'${p}'`).join(", ")}]`)}::text[], ${learnings.priority})`

/** The org's learnings, high priority first, then by how many sessions they came up in. */
export const listLearnings = async (db: Querier, orgId: string): Promise<ListedLearning[]> => {
  const problemCount = sql<number>`count(${reviewProblems.id})::int`
  const sessionCount = sql<number>`count(distinct ${reviewProblems.sessionId})::int`
  const rows = await db
    .select({ learning: learnings, problemCount, sessionCount })
    .from(learnings)
    .leftJoin(reviewProblems, eq(reviewProblems.learningId, learnings.id))
    .where(eq(learnings.orgId, orgId))
    .groupBy(learnings.id)
    .orderBy(PRIORITY_ORDER, desc(sessionCount), desc(problemCount), asc(learnings.createdAt))
  return rows.map((row) => ({
    ...row.learning,
    problemCount: row.problemCount,
    sessionCount: row.sessionCount,
  }))
}

export const getLearning = async (db: Querier, id: string): Promise<LearningRow | null> => {
  const [row] = await db.select().from(learnings).where(eq(learnings.id, id)).limit(1)
  return row ?? null
}

/** The problems behind a learning, with their session and evidence, so a reader can check it. */
export const problemsOfLearning = async (db: Querier, learningId: string) =>
  db
    .select({ ...problemColumns, projectId: reviewProblems.projectId })
    .from(reviewProblems)
    .where(eq(reviewProblems.learningId, learningId))
    .orderBy(asc(reviewProblems.createdAt))
