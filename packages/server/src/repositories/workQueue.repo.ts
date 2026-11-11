import { and, eq, inArray, notInArray, sql } from "drizzle-orm"
import type { Querier } from "../db/client.js"
import { learningRuns, sessionActivityAt, sessionReviews } from "../db/schema.js"
import type { NightlyReview } from "../lib/env.js"

/** A row that fails this many tries becomes `failed` and is not picked again. */
export const MAX_ATTEMPTS = 3

export type QueuedReviewOptions = {
  readonly harness?: string
  readonly model?: string
  readonly prompt?: string
}

/**
 * Puts the session's review in `waiting` with fresh tries, creating the row if needed. A
 * re-review keeps the old result on the row. Null when the review is already waiting or running:
 * one review per (sessionId, analyzer) at a time.
 */
export const queueReview = async (
  db: Querier,
  input: {
    readonly sessionId: string
    readonly projectId: string
    readonly analyzer: string
    readonly options: QueuedReviewOptions
  },
): Promise<{ readonly id: string } | null> => {
  const queued = {
    status: "waiting",
    attempts: 0,
    error: null,
    harness: input.options.harness ?? null,
    model: input.options.model ?? null,
    prompt: input.options.prompt ?? null,
  } as const
  const [row] = await db
    .insert(sessionReviews)
    .values({
      sessionId: input.sessionId,
      projectId: input.projectId,
      analyzer: input.analyzer,
      ...queued,
    })
    .onConflictDoUpdate({
      target: [sessionReviews.sessionId, sessionReviews.analyzer],
      set: { ...queued, updatedAt: new Date() },
      setWhere: inArray(sessionReviews.status, ["done", "failed"]),
    })
    .returning({ id: sessionReviews.id })
  return row ?? null
}

/**
 * Every review left `running` by a worker that is gone goes back to `waiting`, unless that was
 * its 3rd try: a review that crashes the worker would otherwise be retried for ever. `except`
 * names the rows the calling worker is still running.
 */
export const requeueRunningReviews = async (
  db: Querier,
  except: ReadonlyArray<string> = [],
): Promise<number> => {
  const last = sql`${sessionReviews.attempts} >= ${MAX_ATTEMPTS}`
  const rows = await db
    .update(sessionReviews)
    .set({
      status: sql`case when ${last} then 'failed' else 'waiting' end`,
      error: sql`case when ${last} then 'harnessFailed: the worker stopped during the last try' else ${sessionReviews.error} end`,
      updatedAt: new Date(),
    })
    .where(and(eq(sessionReviews.status, "running"), notInArray(sessionReviews.id, [...except])))
    .returning({ id: sessionReviews.id })
  return rows.length
}

export type ClaimedReview = {
  readonly id: string
  readonly sessionId: string
  readonly attempts: number
  readonly harness: string | null
  readonly model: string | null
  readonly prompt: string | null
}

/**
 * Takes the oldest waiting review: one statement moves it to `running` and counts the try.
 * `skip locked` lets a second claimer pass over a row the first is taking, so no row runs twice.
 */
export const claimReview = async (db: Querier): Promise<ClaimedReview | null> => {
  const rows = await db.execute<ClaimedReview>(sql`
    update "sessionReviews" set "status" = 'running', "attempts" = "attempts" + 1, "updatedAt" = now()
    where "id" = (
      select "id" from "sessionReviews" where "status" = 'waiting'
      order by "updatedAt" asc limit 1
      for update skip locked
    )
    returning "id", "sessionId", "attempts", "harness", "model", "prompt"`)
  return rows[0] ?? null
}

/** A failed try: back to `waiting` with the reason, or `failed` once it was the 3rd. */
export const failReviewAttempt = async (
  db: Querier,
  id: string,
  error: string,
): Promise<"waiting" | "failed"> => {
  const [row] = await db
    .update(sessionReviews)
    .set({
      status: sql`case when ${sessionReviews.attempts} >= ${MAX_ATTEMPTS} then 'failed' else 'waiting' end`,
      error,
      updatedAt: new Date(),
    })
    .where(and(eq(sessionReviews.id, id), eq(sessionReviews.status, "running")))
    .returning({ status: sessionReviews.status })
  return row?.status === "failed" ? "failed" : "waiting"
}

/** The row behind a review job id, scoped to its session; null when it is not that session's. */
export const reviewJob = async (db: Querier, sessionId: string, id: string) => {
  const [row] = await db
    .select({
      id: sessionReviews.id,
      status: sessionReviews.status,
      error: sessionReviews.error,
      updatedAt: sessionReviews.updatedAt,
    })
    .from(sessionReviews)
    .where(and(eq(sessionReviews.id, id), eq(sessionReviews.sessionId, sessionId)))
    .limit(1)
  return row ?? null
}

const reviewIn = async (
  db: Querier,
  query: {
    readonly sessionId: string
    readonly analyzer: string
    readonly statuses: ReadonlyArray<string>
  },
) => {
  const [row] = await db
    .select({
      id: sessionReviews.id,
      status: sessionReviews.status,
      error: sessionReviews.error,
      updatedAt: sessionReviews.updatedAt,
    })
    .from(sessionReviews)
    .where(
      and(
        eq(sessionReviews.sessionId, query.sessionId),
        eq(sessionReviews.analyzer, query.analyzer),
        inArray(sessionReviews.status, [...query.statuses]),
      ),
    )
    .limit(1)
  return row ?? null
}

/** The session's review that is waiting or running, if any: a second one is refused. */
export const activeReview = (db: Querier, sessionId: string, analyzer: string) =>
  reviewIn(db, { sessionId, analyzer, statuses: ["waiting", "running"] })

/** The session's review that is waiting, running or failed: what a reloaded page shows. */
export const unfinishedReview = (db: Querier, sessionId: string, analyzer: string) =>
  reviewIn(db, { sessionId, analyzer, statuses: ["waiting", "running", "failed"] })

export type QueuedFixRun = { readonly id: string }

/**
 * Queues a fix run for the project, or updates the one already waiting with this caller's
 * choices, keeping its harness path when this caller gave none. Null when a run is already running there: one open run per project.
 */
export const queueFixRun = async (
  db: Querier,
  input: {
    readonly projectId: string
    readonly waitForReviews: boolean
    readonly harnessPath: string | null
  },
): Promise<QueuedFixRun | null> => {
  const [created] = await db
    .insert(learningRuns)
    .values({ ...input, status: "waiting" })
    .onConflictDoNothing()
    .returning({ id: learningRuns.id })
  if (created !== undefined) return created
  const [waiting] = await db
    .update(learningRuns)
    // A caller with no path (anyone but an admin) must not undo an admin's chosen harness.
    .set({
      waitForReviews: input.waitForReviews,
      ...(input.harnessPath === null ? {} : { harnessPath: input.harnessPath }),
    })
    .where(and(eq(learningRuns.projectId, input.projectId), eq(learningRuns.status, "waiting")))
    .returning({ id: learningRuns.id })
  return waiting ?? null
}

/** Every fix run left `running` by a worker that is gone goes back to `waiting`, as reviews do. */
export const requeueRunningFixRuns = async (
  db: Querier,
  except: ReadonlyArray<string> = [],
): Promise<number> => {
  const last = sql`${learningRuns.attempts} >= ${MAX_ATTEMPTS}`
  const rows = await db
    .update(learningRuns)
    .set({
      status: sql`case when ${last} then 'failed' else 'waiting' end`,
      error: sql`case when ${last} then 'The worker stopped during the last try.' else ${learningRuns.error} end`,
      finishedAt: sql`case when ${last} then now() else null end`,
    })
    .where(and(eq(learningRuns.status, "running"), notInArray(learningRuns.id, [...except])))
    .returning({ id: learningRuns.id })
  return rows.length
}

export type ClaimedFixRun = {
  readonly id: string
  readonly projectId: string
  readonly attempts: number
  readonly harnessPath: string | null
}

/**
 * Takes the oldest waiting fix run that may start: one that does not wait for reviews, or whose
 * project has no review waiting or running. A failed review does not hold it back.
 * `for update of lr` names the run alone, so the claim never locks review rows.
 */
export const claimFixRun = async (db: Querier): Promise<ClaimedFixRun | null> => {
  const rows = await db.execute<ClaimedFixRun>(sql`
    update "learningRuns" set "status" = 'running', "attempts" = "attempts" + 1, "startedAt" = now()
    where "id" = (
      select lr."id" from "learningRuns" lr
      where lr."status" = 'waiting'
        and (not lr."waitForReviews" or not exists (
          select 1 from "sessionReviews" sr
          where sr."projectId" = lr."projectId" and sr."status" in ('waiting', 'running')
        ))
      order by lr."startedAt" asc limit 1
      for update of lr skip locked
    )
    returning "id", "projectId", "attempts", "harnessPath"`)
  return rows[0] ?? null
}

/** A failed try: back to `waiting` with the reason, or `failed` and finished once it was the 3rd. */
export const failFixRunAttempt = async (
  db: Querier,
  id: string,
  error: string,
): Promise<"waiting" | "failed"> => {
  const last = sql`${learningRuns.attempts} >= ${MAX_ATTEMPTS}`
  const [row] = await db
    .update(learningRuns)
    .set({
      status: sql`case when ${last} then 'failed' else 'waiting' end`,
      error,
      finishedAt: sql`case when ${last} then now() else null end`,
    })
    .where(and(eq(learningRuns.id, id), eq(learningRuns.status, "running")))
    .returning({ status: learningRuns.status })
  return row?.status === "failed" ? "failed" : "waiting"
}

/**
 * The every-N-days rule: a project with problems no run has read, and no run queued, running or
 * started in its last `fixRunEveryDays` days, gets a waiting run that waits for its reviews. A
 * failed run counts as a run, so it is tried again N days later, not every minute.
 */
export const queueDueFixRuns = async (db: Querier): Promise<number> => {
  const rows = await db.execute<{ id: string }>(sql`
    insert into "learningRuns" ("projectId", "status", "waitForReviews")
    select p."id", 'waiting', true from "projects" p
    where exists (
      select 1 from "reviewProblems" rp
      where rp."projectId" = p."id" and rp."learningRunId" is null
    )
    and not exists (
      select 1 from "learningRuns" lr
      where lr."projectId" = p."id"
        and (lr."status" in ('waiting', 'running')
          or lr."startedAt" > now() - make_interval(days => p."fixRunEveryDays"))
    )
    on conflict do nothing
    returning "id"`)
  return rows.length
}

/** A session must go this long without a message before a nightly pick takes it. */
export const QUIET_FOR = "6 hours"

/**
 * Only sessions active this recently are candidates, so the ranking reads a month of a project's
 * sessions rather than its whole history. Older ones are reviewed by ticking them.
 */
export const PICK_WITHIN = "30 days"

/**
 * The nightly rule. Each project with automatic review on, whose pick for today is due and not
 * yet made, is stamped as picked and gets `waiting` reviews for its `limit` ready sessions that
 * were active longest ago. A session is ready once it has been quiet for `QUIET_FOR`, or once a
 * pull request it opened is merged or closed. "Today" and the time of day are read in
 * `timeZone`, so a worker started after midnight but before `at` makes no pick for the night
 * before. A session with a row for the analyzer, in any state, is left alone. One statement, so a
 * crash cannot stamp a project without queueing its reviews, or queue them without the stamp.
 */
export const queueNightlyReviews = async (
  db: Querier,
  input: NightlyReview & { readonly now: Date; readonly analyzer: string },
): Promise<{ readonly picked: number; readonly queued: number }> => {
  // drizzle's postgres-js driver cannot bind a Date in raw sql, so the instant goes as text.
  const now = sql`${input.now.toISOString()}::timestamptz`
  const today = sql`date_trunc('day', ${now} at time zone ${input.timeZone})`
  const dueAt = sql`((${today} + ${input.at}::time) at time zone ${input.timeZone})`
  const [row] = await db.execute<{ picked: number; queued: number }>(sql`
    with "picked" as (
      update "projects" set "lastNightlyPickAt" = ${now}
      where "autoReview"
        and ${now} >= ${dueAt}
        and ("lastNightlyPickAt" is null or "lastNightlyPickAt" < ${dueAt})
      returning "id"
    ), "ready" as (
      select "sessions"."id", "sessions"."projectId",
        row_number() over (
          partition by "sessions"."projectId" order by ${sessionActivityAt}, "sessions"."id"
        ) as "rank"
      from "sessions"
      where "sessions"."projectId" in (select "id" from "picked")
        and ${sessionActivityAt} > ${now} - ${PICK_WITHIN}::interval
        and (
          ${sessionActivityAt} <= ${now} - ${QUIET_FOR}::interval
          or exists (
            select 1 from "sessionPullRequests" spr
            join "pullRequests" pr on pr."id" = spr."prId"
            where spr."sessionId" = "sessions"."id" and pr."state" in ('merged', 'closed')
          )
        )
        and not exists (
          select 1 from "sessionReviews" sr
          where sr."sessionId" = "sessions"."id" and sr."analyzer" = ${input.analyzer}
        )
    ), "queued" as (
      insert into "sessionReviews" ("sessionId", "projectId", "analyzer", "status", "attempts")
      select "id", "projectId", ${input.analyzer}, 'waiting', 0 from "ready"
      where "rank" <= ${input.limit}
      on conflict do nothing
      returning "id"
    )
    select (select count(*)::int from "picked") as "picked",
      (select count(*)::int from "queued") as "queued"`)
  return { picked: row?.picked ?? 0, queued: row?.queued ?? 0 }
}
