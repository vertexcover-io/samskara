import type pino from "pino"
import {
  type AiReviewDeps,
  type AiReviewErrorCode,
  type AiReviewOptions,
  type AiReviewRun,
  runAiReview,
} from "./pipeline.js"

/**
 * A named point inside the AI-review pipeline the watcher can see: "harness_spawned",
 * "harness_first_byte", "grounded", "persisted", etc. The CLI's progress line surfaces the
 * latest one so a human can tell what the run is doing without tailing the server log.
 */
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
 * v1 limitation, deliberate: the registry is in-memory, so jobs are lost on restart. The
 * durable record is the database row — once a job succeeds, `sessionReviews` carries the
 * ai-v1 review and its learnings, and a restart simply means an in-flight run must be
 * started again. When that stops being acceptable, back the registry with a table; the
 * interface below is shaped so that swap is internal.
 */
export type AiReviewJobRegistry = {
  /** Fire-and-forget: the pipeline runs in the background; poll `getAiReviewJob` for state. */
  startAiReviewJob: (
    deps: AiReviewDeps,
    userId: string,
    sessionId: string,
    options?: AiReviewOptions,
  ) => { readonly jobId: string } | { readonly error: "busy" }
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

export const createAiReviewJobRegistry = (
  opts: {
    readonly maxConcurrent?: number
    /** Test seam: replaces the pipeline call; production always runs the real one. */
    readonly run?: AiReviewRun
    /** Test seam: replaces `Date.now` so the milestone timestamps are deterministic. */
    readonly now?: () => Date
  } = {},
): AiReviewJobRegistry => {
  const maxConcurrent = opts.maxConcurrent ?? MAX_CONCURRENT_AI_REVIEWS
  const run = opts.run ?? runAiReview
  const now = opts.now ?? (() => new Date())
  const jobs = new Map<string, AiReviewJob>()

  return {
    startAiReviewJob: (deps, userId, sessionId, options) => {
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

      // The pipeline invokes `recordMilestone` via deps so each milestone lands on this job's
      // entry without the registry having to know what the pipeline is doing.
      const milestoneBound: AiReviewDeps = {
        ...deps,
        onMilestone: (name) => {
          const job = jobs.get(jobId)
          if (job?.status !== "running") return
          jobs.set(jobId, { ...job, lastEvent: { name, at: now().toISOString() } })
        },
      }

      // Fire and forget: the registry is the only state, and it settles the entry itself.
      void run(milestoneBound, userId, sessionId, options)
        .then((result) => {
          if (result.kind === "ok") {
            jobs.set(jobId, { status: "succeeded", jobId, reviewId: result.reviewId })
            return
          }
          jobs.set(jobId, { status: "failed", jobId, code: result.code, detail: result.detail })
        })
        .catch((error: unknown) => {
          // The pipeline reports its own failures as results; a throw here is unexpected and
          // surfaces as a generic harness failure so the job still settles.
          const log = (deps as { log?: pino.Logger }).log
          log?.error({ jobId, err: error }, "ai review job crashed unexpectedly")
          jobs.set(jobId, {
            status: "failed",
            jobId,
            code: "harnessFailed",
            detail: { message: error instanceof Error ? error.message : String(error) },
          })
        })

      return { jobId }
    },
    getAiReviewJob: (jobId) => jobs.get(jobId),
    activeJobForSession: (sessionId) =>
      [...jobs.values()].find(
        (job): job is RunningAiReviewJob => job.status === "running" && job.sessionId === sessionId,
      ),
    recordMilestone: (jobId, name) => {
      const job = jobs.get(jobId)
      if (job?.status !== "running") return
      jobs.set(jobId, { ...job, lastEvent: { name, at: now().toISOString() } })
    },
  }
}
