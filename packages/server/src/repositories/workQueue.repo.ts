import { and, desc, eq, inArray, notInArray, type SQL, sql } from "drizzle-orm"
import type { Querier } from "../db/client.js"
import { learningRuns, sessionActivityAt, sessionReviews } from "../db/schema.js"
import type { NightlyReview } from "../lib/env.js"
import type { PullRequestRef } from "./pullRequests.repo.js"
import { newMessagesAfter, shownRun } from "./reviews.repo.js"

/** A row that fails this many tries becomes `failed` and is not picked again. */
export const MAX_ATTEMPTS = 3

export type QueuedReviewOptions = {
  readonly harness?: string
  readonly model?: string
  readonly prompt?: string
}

/**
 * Adds a new `waiting` run for the session. A full run has no `basedOn`; a new-part run names
 * the done run it continues from. Null when a run is already waiting or running: the
 * one-active-run index refuses the insert, and no earlier row is touched.
 */
export const queueReview = async (
  db: Querier,
  input: {
    readonly sessionId: string
    readonly projectId: string
    readonly analyzer: string
    readonly options: QueuedReviewOptions
    /** The done run a new-part run continues from; absent for a full run. */
    readonly basedOn?: string
  },
): Promise<{ readonly id: string } | null> => {
  const [row] = await db
    .insert(sessionReviews)
    .values({
      sessionId: input.sessionId,
      projectId: input.projectId,
      analyzer: input.analyzer,
      status: "waiting",
      attempts: 0,
      harness: input.options.harness ?? null,
      model: input.options.model ?? null,
      prompt: input.options.prompt ?? null,
      newPartOnly: input.basedOn !== undefined,
      basedOn: input.basedOn ?? null,
    })
    .onConflictDoNothing()
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
  readonly newPartOnly: boolean
  /** The done run a new-part run continues from; null for a full run. */
  readonly basedOn: string | null
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
    returning "id", "sessionId", "attempts", "harness", "model", "prompt", "newPartOnly", "basedOn"`)
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
    .orderBy(desc(sessionReviews.createdAt))
    .limit(1)
  return row ?? null
}

/** The session's review that is waiting or running, if any: a second one is refused. */
export const activeReview = (db: Querier, sessionId: string, analyzer: string) =>
  reviewIn(db, { sessionId, analyzer, statuses: ["waiting", "running"] })

/**
 * What a reloaded page shows as the job: the run that is waiting or running, else the session's
 * newest run when that one failed. A failed run followed by a done one is over.
 */
export const unfinishedReview = async (db: Querier, sessionId: string, analyzer: string) => {
  const newest = await reviewIn(db, {
    sessionId,
    analyzer,
    statuses: ["waiting", "running", "done", "failed"],
  })
  return newest === null || newest.status === "done" ? null : newest
}

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
      join "sessionReviews" sr on sr."id" = rp."reviewId"
      where rp."projectId" = p."id" and rp."learningRunId" is null
        and ${shownRun(sql`sr`)}
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

/** How many open pull requests the check before one nightly pick asks GitHub about, at most. */
export const PR_CHECK_LIMIT = 200

type NightlyInput = NightlyReview & { readonly now: Date; readonly analyzer: string }

/**
 * The instant as SQL, and the rule for a project whose pick is due: automatic review on, the
 * day's time reached in `timeZone`, and no pick made since it. Reads `"projects"` unaliased.
 */
const nightlyClock = (input: NightlyInput) => {
  // drizzle's postgres-js driver cannot bind a Date in raw sql, so the instant goes as text.
  const now = sql`${input.now.toISOString()}::timestamptz`
  const today = sql`date_trunc('day', ${now} at time zone ${input.timeZone})`
  const dueAt = sql`((${today} + ${input.at}::time) at time zone ${input.timeZone})`
  const due = sql`"projects"."autoReview"
    and ${now} >= ${dueAt}
    and ("projects"."lastNightlyPickAt" is null or "projects"."lastNightlyPickAt" < ${dueAt})`
  return { now, due }
}

/**
 * The newest review run of `"sessions"` for `analyzer`, any status, as a lateral row named
 * `last`; the caller joins it with `left join lateral … on true`.
 */
const lastRun = (analyzer: string): SQL => sql`(
  select r."id", r."status", r."lastMessageId", r."updatedAt"
  from "sessionReviews" r
  where r."sessionId" = "sessions"."id" and r."analyzer" = ${analyzer}
  order by r."createdAt" desc limit 1
)`

/**
 * Whether tonight's pick may take `"sessions"`, given its newest run `last` (null when never
 * reviewed). Never reviewed: yes. Newest run done: when the session has messages that run did
 * not read (`newMessagesAfter`). Newest run failed: once a message was stored after it failed,
 * so a failure is not retried every night on the same messages; a failed run has no
 * `lastMessageId`, so the new-messages rule would call every message new. Waiting or running: no.
 */
const pickableSession = sql`(
  "last"."id" is null
  or ("last"."status" = 'done' and ${newMessagesAfter(sql`"sessions"."id"`, sql`"last"`)})
  or ("last"."status" = 'failed' and exists (
    select 1 from "messages" fm
    where fm."sessionId" = "sessions"."id" and fm."createdAt" > "last"."updatedAt"
  ))
)`

/**
 * The open github.com pull requests opened by a session tonight's pick could take only through
 * its pull request (one not yet quiet for `QUIET_FOR`), for the check that asks GitHub before
 * the pick: at most `PR_CHECK_LIMIT`, never-checked first, then
 * the ones checked longest ago. Empty unless some project's pick is due, so the every-minute
 * claim pass makes no GitHub call. Reads only.
 */
export const pullRequestsToCheck = async (
  db: Querier,
  input: NightlyInput,
): Promise<ReadonlyArray<PullRequestRef>> => {
  const { now, due } = nightlyClock(input)
  const rows = await db.execute<PullRequestRef>(sql`
    select pr."id", r."owner", r."repoName" as "repo", pr."number"
    from "pullRequests" pr
    join "repos" r on r."id" = pr."repoId"
    where pr."state" = 'open'
      and lower(r."host") = 'github.com'
      and exists (
        select 1 from "sessionPullRequests" spr
        join "sessions" on "sessions"."id" = spr."sessionId"
        join "projects" on "projects"."id" = "sessions"."projectId"
        left join lateral ${lastRun(input.analyzer)} "last" on true
        where spr."prId" = pr."id"
          and ${due}
          and ${sessionActivityAt} > ${now} - ${PICK_WITHIN}::interval
          and ${sessionActivityAt} > ${now} - ${QUIET_FOR}::interval
          and ${pickableSession}
      )
    order by pr."checkedAt" asc nulls first, pr."id"
    limit ${PR_CHECK_LIMIT}`)
  return [...rows]
}

/**
 * The nightly rule. Each project with automatic review on, whose pick for today is due and not
 * yet made, is stamped as picked and gets `waiting` reviews for its `limit` ready sessions. A
 * session is a candidate when `pickableSession` holds: never reviewed, reviewed with new
 * messages, or failed with messages since. It is ready once quiet for `QUIET_FOR`, or once a pull
 * request it opened is merged or closed (for a reviewed session, after its last run). Never
 * reviewed go first, then an ended pull request, then the ones active longest ago. A session
 * with a done run gets a new-part run based on its newest one; others get a full run. "Today"
 * and the time of day are read in `timeZone`, so a worker started after midnight but before
 * `at` makes no pick for the night before. One statement, so a crash cannot stamp a project
 * without queueing its reviews, or queue them without the stamp.
 */
export const queueNightlyReviews = async (
  db: Querier,
  input: NightlyInput,
): Promise<{ readonly picked: number; readonly queued: number }> => {
  const { now, due } = nightlyClock(input)
  const [row] = await db.execute<{ picked: number; queued: number }>(sql`
    with "picked" as (
      update "projects" set "lastNightlyPickAt" = ${now}
      where ${due}
      returning "id"
    ), "candidates" as (
      select "sessions"."id", "sessions"."projectId", ${sessionActivityAt} as "activityAt",
        "last"."id" is null as "neverReviewed",
        (
          select d."id" from "sessionReviews" d
          where d."sessionId" = "sessions"."id" and d."analyzer" = ${input.analyzer}
            and d."status" = 'done'
          order by d."createdAt" desc limit 1
        ) as "basedOn",
        exists (
          select 1 from "sessionPullRequests" spr
          join "pullRequests" pr on pr."id" = spr."prId"
          where spr."sessionId" = "sessions"."id" and pr."state" in ('merged', 'closed')
            -- A reviewed session counts only a pull request that ended after its last run.
            and ("last"."id" is null or pr."closedAt" > "last"."updatedAt")
        ) as "prEnded"
      from "sessions"
      left join lateral ${lastRun(input.analyzer)} "last" on true
      where "sessions"."projectId" in (select "id" from "picked")
        and ${sessionActivityAt} > ${now} - ${PICK_WITHIN}::interval
        and ${pickableSession}
    ), "ready" as (
      -- Never reviewed first; then an ended pull request, which is recent, so oldest-first alone
      -- would leave it behind every quiet session of a busy project; then the oldest.
      select "id", "projectId", "basedOn",
        row_number() over (
          partition by "projectId"
          order by "neverReviewed" desc, "prEnded" desc, "activityAt", "id"
        ) as "rank"
      from "candidates"
      where "prEnded" or "activityAt" <= ${now} - ${QUIET_FOR}::interval
    ), "queued" as (
      -- The one-active-run index makes "on conflict" a race guard: pickableSession already
      -- leaves out a session with a run waiting or running.
      insert into "sessionReviews"
        ("sessionId", "projectId", "analyzer", "status", "attempts", "newPartOnly", "basedOn")
      select "id", "projectId", ${input.analyzer}, 'waiting', 0, "basedOn" is not null, "basedOn"
      from "ready"
      where "rank" <= ${input.limit}
      on conflict do nothing
      returning "id"
    )
    select (select count(*)::int from "picked") as "picked",
      (select count(*)::int from "queued") as "queued"`)
  return { picked: row?.picked ?? 0, queued: row?.queued ?? 0 }
}
