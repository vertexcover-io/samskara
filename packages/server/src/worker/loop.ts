import type { HarnessSource } from "@samskara/core"
import type pino from "pino"
import type { Db } from "../db/client.js"
import type { NightlyReview, ReviewHarness } from "../lib/env.js"
import { finishRun, type RunOutcome } from "../repositories/learnings.repo.js"
import { savePullRequestStates } from "../repositories/pullRequests.repo.js"
import {
  type ClaimedFixRun,
  type ClaimedReview,
  claimFixRun,
  claimReview,
  failFixRunAttempt,
  failReviewAttempt,
  pullRequestsToCheck,
  queueDueFixRuns,
  queueNightlyReviews,
  requeueRunningFixRuns,
  requeueRunningReviews,
} from "../repositories/workQueue.repo.js"
import {
  type AiReviewOptions,
  type AiReviewResult,
  PROBLEMS_ANALYZER,
} from "../services/ai-review/pipeline.js"
import type { PullRequestLookup } from "../services/pullRequestStates.js"

/** How many reviews this worker runs at once; the machine has room for no more. */
export const REVIEW_SLOTS = 2

export type WorkLoopDeps = {
  readonly db: Db
  readonly log: pino.Logger
  /** Runs one claimed review to its end; production is `runAiReview` with the row's options. */
  readonly runReview: (review: ClaimedReview) => Promise<AiReviewResult>
  /** Runs one claimed fix run's try; undefined leaves fix runs alone. */
  readonly runFixRun?: (run: ClaimedFixRun) => Promise<RunOutcome>
  /** Queue automatic every-N-days runs; false when the server has no harness of its own. */
  readonly queueDue?: boolean
  /** When and how many sessions to queue for review each night; undefined queues none. */
  readonly nightlyReview?: NightlyReview
  /**
   * Asks GitHub for pull request states before the nightly pick; undefined when the server has
   * no token, and the pick then goes by the 6-hour rule alone.
   */
  readonly pullRequestLookup?: PullRequestLookup
  /** The clock the nightly pick reads; tests set it, production leaves it to the real one. */
  readonly now?: () => Date
  readonly reviewSlots?: number
}

export type WorkLoop = {
  /** Claims and starts what fits now; safe to call at any time and as often as wanted. */
  readonly tick: () => Promise<void>
  /** Resolves once nothing this loop started is still running: for tests and shutdown. */
  readonly idle: () => Promise<void>
  /**
   * The worker is going away: claim nothing more, and leave a try that ends from here on
   * `running`, since its agent was most likely killed. The next worker requeues it.
   */
  readonly stop: () => void
}

/** The reason saved on a failed try: the code, then whatever message the pipeline gave. */
export const reviewError = (result: Extract<AiReviewResult, { kind: "error" }>): string => {
  const detail = result.detail as { message?: unknown } | undefined
  return typeof detail?.message === "string" ? `${result.code}: ${detail.message}` : result.code
}

export const createWorkLoop = (deps: WorkLoopDeps): WorkLoop => {
  const slots = deps.reviewSlots ?? REVIEW_SLOTS
  const inFlight = new Set<Promise<void>>()
  /** Row ids this loop is running: any other `running` row lost its result and is requeued. */
  const runningIds = new Set<string>()
  let reviewsRunning = 0
  let fixRunRunning = false
  let ticking: Promise<void> | null = null
  let stopped = false

  const finish = async (review: ClaimedReview): Promise<void> => {
    const log = deps.log.child({ reviewId: review.id, sessionId: review.sessionId })
    try {
      const result = await deps.runReview(review)
      if (result.kind === "ok") return log.info({ attempts: review.attempts }, "review done")
      if (stopped) return log.info("review try ended while stopping; left for the next worker")
      const now = await failReviewAttempt(deps.db, review.id, reviewError(result))
      log.warn({ attempts: review.attempts, code: result.code, now }, "review try failed")
    } catch (error) {
      if (stopped) return log.info("review try ended while stopping; left for the next worker")
      const message = error instanceof Error ? error.message : String(error)
      const now = await failReviewAttempt(deps.db, review.id, `harnessFailed: ${message}`)
      log.error({ err: error, attempts: review.attempts, now }, "review try crashed")
    }
  }

  const start = (review: ClaimedReview): void => {
    reviewsRunning += 1
    runningIds.add(review.id)
    const running = finish(review)
      .catch((error: unknown) => deps.log.error({ err: error }, "review could not be settled"))
      .finally(() => {
        reviewsRunning -= 1
        runningIds.delete(review.id)
        inFlight.delete(running)
        void tick()
      })
    inFlight.add(running)
  }

  const finishFixRun = async (
    run: ClaimedFixRun,
    runFixRun: NonNullable<WorkLoopDeps["runFixRun"]>,
  ): Promise<void> => {
    const log = deps.log.child({ learningRunId: run.id, projectId: run.projectId })
    try {
      const outcome = await runFixRun(run)
      if (outcome.status === "done") return await finishRun(deps.db, run.id, outcome)
      if (stopped) return log.info("fix run try ended while stopping; left for the next worker")
      const now = await failFixRunAttempt(deps.db, run.id, outcome.error)
      log.warn({ attempts: run.attempts, now }, "fix run try failed")
    } catch (error) {
      if (stopped) return log.info("fix run try ended while stopping; left for the next worker")
      const message = error instanceof Error ? error.message : String(error)
      const now = await failFixRunAttempt(deps.db, run.id, message)
      log.error({ err: error, attempts: run.attempts, now }, "fix run try crashed")
    }
  }

  /** One fix run at a time: each takes a harness snapshot and two agents, from shared slots. */
  const startFixRun = (
    run: ClaimedFixRun,
    runFixRun: NonNullable<WorkLoopDeps["runFixRun"]>,
  ): void => {
    fixRunRunning = true
    runningIds.add(run.id)
    const running = finishFixRun(run, runFixRun)
      .catch((error: unknown) => deps.log.error({ err: error }, "fix run could not be settled"))
      .finally(() => {
        fixRunRunning = false
        runningIds.delete(run.id)
        inFlight.delete(running)
        void tick()
      })
    inFlight.add(running)
  }

  let toldNoToken = false

  /**
   * Asks GitHub about the open pull requests of sessions tonight's pick could take, and saves
   * the answers, so the pick sees merged and closed ones. Never throws: the pick goes on.
   */
  const checkPullRequests = async (nightly: NightlyReview, now: Date): Promise<void> => {
    const lookup = deps.pullRequestLookup
    if (lookup === undefined) {
      if (!toldNoToken)
        deps.log.info(
          "no LEARNINGS_HARNESS_GITHUB_TOKEN: the nightly pick will not read pull request states",
        )
      toldNoToken = true
      return
    }
    try {
      const prs = await pullRequestsToCheck(deps.db, {
        ...nightly,
        now,
        analyzer: PROBLEMS_ANALYZER,
      })
      if (prs.length === 0) return
      const { answers, failures } = await lookup(prs)
      const saved = await savePullRequestStates(deps.db, answers, now)
      const ended = answers.filter((a) => a.state === "merged" || a.state === "closed").length
      // unseen: GitHub returned no pull request, most often a repo the token cannot read.
      const unseen = answers.filter((a) => a.state === null).length
      deps.log.info({ asked: prs.length, saved, ended, unseen }, "pull request states checked")
      if (failures.length > 0)
        deps.log.warn({ failures }, "pull request checks failed; those wait for the 6-hour rule")
    } catch (error) {
      deps.log.warn({ err: error }, "pull request check failed; picking on the 6-hour rule")
    }
  }

  /** Before the claims, so tonight's picked rows start in this same pass. */
  const pickNightly = async (): Promise<void> => {
    const nightly = deps.nightlyReview
    if (nightly === undefined) return
    const now = (deps.now ?? (() => new Date()))()
    // Outside the pick's statement: the GitHub calls never hold it open.
    await checkPullRequests(nightly, now)
    try {
      const { picked, queued } = await queueNightlyReviews(deps.db, {
        ...nightly,
        now,
        analyzer: PROBLEMS_ANALYZER,
      })
      if (picked > 0) deps.log.info({ picked, queued }, "nightly reviews queued")
    } catch (error) {
      deps.log.error({ err: error }, "nightly pick failed; claiming what is already waiting")
    }
  }

  const claimWhatFits = async (): Promise<void> => {
    if (stopped) return
    // The advisory lock makes this the only worker, so a running row it is not running is one
    // whose result failed to save; left alone it would show running until the next restart.
    const requeued = await requeueRunningReviews(deps.db, [...runningIds])
    const requeuedFixRuns = await requeueRunningFixRuns(deps.db, [...runningIds])
    if (requeued + requeuedFixRuns > 0)
      deps.log.warn({ requeued, requeuedFixRuns }, "requeued rows left running")
    await pickNightly()
    while (!stopped && reviewsRunning < slots) {
      const review = await claimReview(deps.db)
      if (review === null) break
      start(review)
    }
    const runFixRun = deps.runFixRun
    if (runFixRun === undefined || fixRunRunning) return
    // The due check rides on the claim pass, which already runs every minute and on new work.
    if (deps.queueDue === true) {
      const queued = await queueDueFixRuns(deps.db)
      if (queued > 0) deps.log.info({ queued }, "fix runs queued for projects that are due")
    }
    const run = await claimFixRun(deps.db)
    if (run !== null) startFixRun(run, runFixRun)
  }

  /** One claim pass at a time: a tick asked for during a pass waits for it, then runs its own. */
  const tick = async (): Promise<void> => {
    while (ticking !== null) await ticking
    ticking = claimWhatFits()
      .catch((error: unknown) => deps.log.error({ err: error }, "work check failed"))
      .finally(() => {
        ticking = null
      })
    await ticking
  }

  const idle = async (): Promise<void> => {
    while (inFlight.size > 0 || ticking !== null) await Promise.all([...inFlight, ticking])
  }

  return {
    tick,
    idle,
    stop: () => {
      stopped = true
    },
  }
}

/** Narrows a stored harness name to the ones the server knows; anything else uses the default. */
export const storedHarness = (value: string | null): ReviewHarness | undefined =>
  value === "claude" || value === "opencode" ? value : undefined

/** The run options a claimed review carries: what the person chose when they queued it. */
export const reviewOptions = (review: ClaimedReview): AiReviewOptions => {
  const harness = storedHarness(review.harness)
  return {
    ...(harness === undefined ? {} : { harness }),
    ...(review.model === null ? {} : { model: review.model }),
    ...(review.prompt === null ? {} : { prompt: review.prompt }),
    ...(review.newPartOnly ? { newPartOnly: true } : {}),
  }
}

/**
 * Runs one fix run's try on the harness path it was queued with, else the server's own harness;
 * with neither it fails without running.
 */
export const fixRunner =
  (deps: {
    readonly serverHarness: HarnessSource | undefined
    readonly execute: (run: ClaimedFixRun, harness: HarnessSource) => Promise<RunOutcome>
  }) =>
  async (run: ClaimedFixRun): Promise<RunOutcome> => {
    const harness = run.harnessPath === null ? deps.serverHarness : { path: run.harnessPath }
    if (harness === undefined)
      return {
        status: "failed",
        error: "No harness for fix runs: set LEARNINGS_HARNESS_REPO or LEARNINGS_HARNESS_PATH.",
      }
    return deps.execute(run, harness)
  }
