import type pino from "pino"
import {
  type AiReviewDeps,
  type AiReviewErrorCode,
  type AiReviewOptions,
  type AiReviewRun,
  runAiReview,
} from "./pipeline.js"

/** A phase boundary the CLI's progress line shows, so a long run never looks frozen. */
export type AiReviewMilestone = {
  readonly name: string
  /** ISO timestamp — the registry never knows the run's clock, so this is the registry's. */
  readonly at: string
}

export type AiReviewJob =
  | {
      readonly status: "running"
      readonly jobId: string
      readonly sessionId: string
      readonly userId: string
      readonly startedAt: string
      /** Latest milestone the pipeline has reported, if any. */
      readonly lastEvent: AiReviewMilestone | null
    }
  | { readonly status: "succeeded"; readonly jobId: string; readonly reviewId: string }
  | {
      readonly status: "failed"
      readonly jobId: string
      readonly code: AiReviewErrorCode
      readonly detail?: unknown
    }

export type RunningAiReviewJob = Extract<AiReviewJob, { readonly status: "running" }>

/**
 * In-memory, so a restart loses in-flight runs; the durable record is the sessionReviews
 * row. Back it with a table when that stops being acceptable -- the interface allows it.
 */
export type AiReviewJobRegistry = {
  /** Fire-and-forget: the pipeline runs in the background; poll `getAiReviewJob` for state. */
  startAiReviewJob: (
    deps: AiReviewDeps,
    userId: string,
    sessionId: string,
    options?: AiReviewOptions,
  ) => { readonly jobId: string } | { readonly error: "busy" | "alreadyRunning" }
  getAiReviewJob: (jobId: string) => AiReviewJob | undefined
  /**
   * The session's non-terminal job, if one exists — the lookup behind both the analyze
   * conflict guard and the aireview response's `job` field, so a reload can rejoin a run
   * and a second click cannot duplicate it. Settled jobs never match: they neither block
   * a re-run nor belong in a response about the present.
   */
  activeJobForSession: (sessionId: string) => RunningAiReviewJob | undefined
  /**
   * Pipeline hook: stamps the latest milestone on the running job so the CLI can render it.
   * No-op once the job has settled; safe to call after success/failure (the registry just
   * ignores the call, so callers don't have to thread "are we still running?" through the
   * pipeline).
   */
  recordMilestone: (jobId: string, name: string) => void
}

export const MAX_CONCURRENT_AI_REVIEWS = 4

/** Settled jobs are read for seconds, so the map keeps this many and drops the oldest. */
export const MAX_SETTLED_AI_REVIEWS = 64

export const createAiReviewJobRegistry = (
  opts: {
    readonly maxConcurrent?: number
    /** Test seam: replaces the pipeline call; production always runs the real one. */
    readonly run?: AiReviewRun
    /** Test seam: replaces `Date.now` so the milestone timestamps are deterministic. */
    readonly now?: () => Date
    /** Test seam: how many settled jobs to retain before the oldest is dropped. */
    readonly maxSettled?: number
  } = {},
): AiReviewJobRegistry => {
  const maxConcurrent = opts.maxConcurrent ?? MAX_CONCURRENT_AI_REVIEWS
  const maxSettled = opts.maxSettled ?? MAX_SETTLED_AI_REVIEWS
  const run = opts.run ?? runAiReview
  const now = opts.now ?? (() => new Date())
  const jobs = new Map<string, AiReviewJob>()

  /** A Map keeps insertion order, and re-setting a key does not move it, so head is oldest. */
  const settle = (jobId: string, job: AiReviewJob): void => {
    jobs.set(jobId, job)
    const settled = [...jobs.entries()].filter(([, entry]) => entry.status !== "running")
    for (const [id] of settled.slice(0, Math.max(0, settled.length - maxSettled))) {
      jobs.delete(id)
    }
  }

  const activeFor = (sessionId: string): RunningAiReviewJob | undefined =>
    [...jobs.values()].find(
      (job): job is RunningAiReviewJob => job.status === "running" && job.sessionId === sessionId,
    )

  /** Records the latest milestone on a running job; a no-op once the job has settled. */
  const stamp = (jobId: string, name: string): void => {
    const job = jobs.get(jobId)
    if (job?.status !== "running") return
    jobs.set(jobId, { ...job, lastEvent: { name, at: now().toISOString() } })
  }

  return {
    startAiReviewJob: (deps, userId, sessionId, options) => {
      // The per-session guard lives here, not in the route. The route's own check is a
      // separate turn of the event loop from this call, so two concurrent POSTs could both
      // pass it and both start a run. This function never awaits between the check and the
      // insert, so it is the only place the invariant can actually hold.
      if (activeFor(sessionId) !== undefined) return { error: "alreadyRunning" }
      const running = [...jobs.values()].filter((job) => job.status === "running").length
      if (running >= maxConcurrent) return { error: "busy" }

      const jobId = crypto.randomUUID()
      jobs.set(jobId, {
        status: "running",
        jobId,
        sessionId,
        userId,
        startedAt: now().toISOString(),
        lastEvent: null,
      })

      // The pipeline stamps milestones through deps so each one lands on this job's entry
      // without the registry having to know what the pipeline is doing. Same `stamp` the
      // public `recordMilestone` uses — one copy, so the hook and the method cannot drift.
      const milestoneBound: AiReviewDeps = {
        ...deps,
        onMilestone: (name) => stamp(jobId, name),
      }

      // Fire and forget: the registry is the only state, and it settles the entry itself.
      void run(milestoneBound, userId, sessionId, options)
        .then((result) => {
          if (result.kind === "ok") {
            settle(jobId, { status: "succeeded", jobId, reviewId: result.reviewId })
            return
          }
          settle(jobId, { status: "failed", jobId, code: result.code, detail: result.detail })
        })
        .catch((error: unknown) => {
          // The pipeline reports its own failures as results; a throw here is unexpected and
          // surfaces as a generic harness failure so the job still settles.
          const log = (deps as { log?: pino.Logger }).log
          log?.error({ jobId, err: error }, "ai review job crashed unexpectedly")
          settle(jobId, {
            status: "failed",
            jobId,
            code: "harnessFailed",
            detail: { message: error instanceof Error ? error.message : String(error) },
          })
        })

      return { jobId }
    },
    getAiReviewJob: (jobId) => jobs.get(jobId),
    activeJobForSession: activeFor,
    recordMilestone: stamp,
  }
}
