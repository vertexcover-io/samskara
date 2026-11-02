import type pino from "pino"
import type { AiReviewJobRegistry } from "../ai-review/jobs.js"
import type { AiReviewDeps, AiReviewErrorCode } from "../ai-review/pipeline.js"
import type { StartedLearningRun } from "../learnings/run.js"

/**
 * How many of a batch's reviews run at once. The job registry allows 4, so one stays open for
 * someone clicking Analyze by hand while a batch runs.
 */
export const REVIEW_BATCH_LANES = 3

/** The most sessions one batch takes. */
export const MAX_REVIEW_BATCH_SESSIONS = 50

/** How long a lane waits before asking the job registry again: after `busy`, and between polls. */
export const REVIEW_POLL_MS = 5_000

/** How long step 2 waits before trying again a project whose learning run is already going. */
export const LEARNING_RETRY_MS = 30_000

/**
 * Step 2 gives up on a project whose earlier learning run has not ended in this long. A run row
 * left `running` (its finish failed to save) blocks the project until the next restart, and the
 * batch must not wait on it forever.
 */
export const LEARNING_WAIT_LIMIT_MS = 2 * 60 * 60 * 1000

export type BatchSessionState =
  | "waiting"
  | "reviewing"
  | "reviewed"
  | "skipped"
  | "failed"
  | "notAllowed"

export type BatchProjectState = "waiting" | "running" | "done" | "failed"

export type BatchSession = {
  readonly sessionId: string
  /** Null for a session the user may not review: its project is not theirs to see. */
  readonly projectId: string | null
  readonly state: BatchSessionState
  /** Why it failed, in plain words; null otherwise. */
  readonly reason: string | null
}

export type BatchProject = {
  readonly projectId: string
  readonly name: string
  readonly state: BatchProjectState
  readonly reason: string | null
}

export type ReviewBatch = {
  readonly batchId: string
  readonly userId: string
  readonly status: "running" | "done"
  readonly startedAt: string
  readonly sessions: ReadonlyArray<BatchSession>
  readonly projects: ReadonlyArray<BatchProject>
}

export type ReviewBatchDeps = {
  /** The app's one job registry, the one Analyze uses, so the limit of 4 is shared. */
  readonly jobs: AiReviewJobRegistry
  /** What each review job runs with: the same db, runner and env as Analyze. */
  readonly aiReview: AiReviewDeps
  /** True when the session already has a problems review. */
  readonly hasReview: (userId: string, sessionId: string) => Promise<boolean>
  /** Starts one project's learning run; undefined when the server has no learnings harness. */
  readonly startLearningRun: ((projectId: string) => Promise<StartedLearningRun>) | undefined
  readonly log: pino.Logger
  /** Test seams: production waits in real time. */
  readonly sleep?: (ms: number) => Promise<void>
  readonly now?: () => Date
  readonly pollMs?: number
  readonly learningRetryMs?: number
  readonly learningWaitLimitMs?: number
}

export type ReviewBatchInput = {
  readonly userId: string
  /** The sessions to review, each with its project. */
  readonly sessions: ReadonlyArray<{ readonly sessionId: string; readonly projectId: string }>
  /** Ids the user may not review; recorded so the page can say so, never reviewed. */
  readonly notAllowed: ReadonlyArray<string>
  readonly projectNames: ReadonlyMap<string, string>
}

export type ReviewBatchRegistry = {
  /** Refuses while the user's previous batch still runs. `finished` settles when it ends. */
  readonly start: (
    input: ReviewBatchInput,
  ) =>
    | { readonly batchId: string; readonly finished: Promise<void> }
    | { readonly error: "alreadyRunning" }
  /** The user's latest batch, kept after it ends so a refreshed page still shows it. */
  readonly current: (userId: string) => ReviewBatch | undefined
}

/** Why a review failed, in words the person who started the batch can act on. */
const REVIEW_FAILED: Readonly<Record<AiReviewErrorCode, string>> = {
  sessionNotFound: "The session could not be found.",
  notEditable: "You cannot edit this session's project.",
  harnessUnauthenticated: "The reviewer has no key on this server.",
  harnessFailed: "The reviewer stopped with an error.",
  deliverableMissing: "The reviewer did not write a review.",
  unparseable: "The reviewer's answer could not be read.",
  promptMergeFailed: "The review prompt could not be built.",
}
const RESULT_LOST = "The review ended, but its result was lost before the batch read it."
const COULD_NOT_START = "The review could not start."
const NO_HARNESS =
  "Finding fixes is not set up on this server. Set LEARNINGS_HARNESS_REPO or LEARNINGS_HARNESS_PATH."
const NO_REVIEWS = "No session of this project got a review."
const WAITED_TOO_LONG = "Another fix run for this project did not end within 2 hours."
const RUN_FAILED = "The fix run failed. Its log is on the server."
const RUN_COULD_NOT_START = "The fix run could not start."

export const createReviewBatchRegistry = (deps: ReviewBatchDeps): ReviewBatchRegistry => {
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const now = deps.now ?? (() => new Date())
  const pollMs = deps.pollMs ?? REVIEW_POLL_MS
  const learningRetryMs = deps.learningRetryMs ?? LEARNING_RETRY_MS
  const learningWaitLimitMs = deps.learningWaitLimitMs ?? LEARNING_WAIT_LIMIT_MS
  /** One entry per user: their latest batch. Bounded by the number of users. */
  const batches = new Map<string, ReviewBatch>()

  const update = (userId: string, change: (batch: ReviewBatch) => ReviewBatch): void => {
    const batch = batches.get(userId)
    if (batch !== undefined) batches.set(userId, change(batch))
  }

  const setSession = (
    userId: string,
    sessionId: string,
    state: BatchSessionState,
    reason: string | null = null,
  ): void =>
    update(userId, (batch) => ({
      ...batch,
      sessions: batch.sessions.map((session) =>
        session.sessionId === sessionId ? { ...session, state, reason } : session,
      ),
    }))

  const setProject = (
    userId: string,
    projectId: string,
    state: BatchProjectState,
    reason: string | null = null,
  ): void =>
    update(userId, (batch) => ({
      ...batch,
      projects: batch.projects.map((project) =>
        project.projectId === projectId ? { ...project, state, reason } : project,
      ),
    }))

  /** Polls one job until it settles. A job the registry already dropped is judged by the saved row. */
  const waitForJob = async (userId: string, sessionId: string, jobId: string): Promise<void> => {
    for (;;) {
      await sleep(pollMs)
      const job = deps.jobs.getAiReviewJob(jobId)
      if (job?.status === "running") continue
      if (job?.status === "succeeded") return setSession(userId, sessionId, "reviewed")
      if (job?.status === "failed")
        return setSession(userId, sessionId, "failed", REVIEW_FAILED[job.code])
      return (await deps.hasReview(userId, sessionId))
        ? setSession(userId, sessionId, "reviewed")
        : setSession(userId, sessionId, "failed", RESULT_LOST)
    }
  }

  /**
   * Reviews one session, or skips it when it already has a review. `busy` (4 reviews running)
   * and `alreadyRunning` (someone is analyzing this session by hand) both wait and ask again;
   * the second ends as skipped once that review lands.
   */
  const reviewOne = async (userId: string, sessionId: string): Promise<void> => {
    for (;;) {
      if (await deps.hasReview(userId, sessionId)) return setSession(userId, sessionId, "skipped")
      const started = deps.jobs.startAiReviewJob(deps.aiReview, userId, sessionId, {})
      if ("jobId" in started) {
        setSession(userId, sessionId, "reviewing")
        return waitForJob(userId, sessionId, started.jobId)
      }
      await sleep(pollMs)
    }
  }

  /** Step 1: every session through at most REVIEW_BATCH_LANES lanes, each taking the next id. */
  const reviewAll = async (
    userId: string,
    sessionIds: ReadonlyArray<string>,
    log: pino.Logger,
  ): Promise<void> => {
    const queue = [...sessionIds]
    const lane = async (): Promise<void> => {
      for (let sessionId = queue.shift(); sessionId !== undefined; sessionId = queue.shift()) {
        try {
          await reviewOne(userId, sessionId)
        } catch (error) {
          log.error({ err: error, sessionId }, "review batch could not review a session")
          setSession(userId, sessionId, "failed", COULD_NOT_START)
        }
      }
    }
    const lanes = Math.min(REVIEW_BATCH_LANES, sessionIds.length)
    await Promise.all(Array.from({ length: lanes }, lane))
  }

  /** One project's learning run: started, or retried while another run there is going. */
  const findFixesFor = async (
    userId: string,
    projectId: string,
    start: (projectId: string) => Promise<StartedLearningRun>,
  ): Promise<void> => {
    const giveUpAt = now().getTime() + learningWaitLimitMs
    for (;;) {
      const started = await start(projectId)
      if (started.status === "started") {
        setProject(userId, projectId, "running")
        const result = await started.finished
        return setProject(userId, projectId, result, result === "failed" ? RUN_FAILED : null)
      }
      if (now().getTime() >= giveUpAt)
        return setProject(userId, projectId, "failed", WAITED_TOO_LONG)
      await sleep(learningRetryMs)
    }
  }

  /** Step 2: one learning run per project that has a reviewed or skipped session, in turn. */
  const findFixes = async (userId: string, log: pino.Logger): Promise<void> => {
    const batch = batches.get(userId)
    if (batch === undefined) return
    const reviewed = new Set(
      batch.sessions
        .filter((session) => session.state === "reviewed" || session.state === "skipped")
        .map((session) => session.projectId),
    )
    for (const { projectId } of batch.projects) {
      if (!reviewed.has(projectId)) {
        setProject(userId, projectId, "failed", NO_REVIEWS)
        continue
      }
      if (deps.startLearningRun === undefined) {
        setProject(userId, projectId, "failed", NO_HARNESS)
        continue
      }
      try {
        await findFixesFor(userId, projectId, deps.startLearningRun)
      } catch (error) {
        log.error({ err: error, projectId }, "review batch could not start a learning run")
        setProject(userId, projectId, "failed", RUN_COULD_NOT_START)
      }
    }
  }

  return {
    start: (input) => {
      if (batches.get(input.userId)?.status === "running") return { error: "alreadyRunning" }
      const batchId = crypto.randomUUID()
      const projectIds = [...new Set(input.sessions.map((session) => session.projectId))]
      batches.set(input.userId, {
        batchId,
        userId: input.userId,
        status: "running",
        startedAt: now().toISOString(),
        sessions: [
          ...input.sessions.map((session) => ({
            sessionId: session.sessionId,
            projectId: session.projectId,
            state: "waiting" as const,
            reason: null,
          })),
          ...input.notAllowed.map((sessionId) => ({
            sessionId,
            projectId: null,
            state: "notAllowed" as const,
            reason: null,
          })),
        ],
        projects: projectIds.map((projectId) => ({
          projectId,
          name: input.projectNames.get(projectId) ?? projectId,
          state: "waiting" as const,
          reason: null,
        })),
      })
      const log = deps.log.child({ reviewBatchId: batchId, userId: input.userId })
      log.info(
        { sessions: input.sessions.length, notAllowed: input.notAllowed.length },
        "review batch started",
      )
      const finished = (async (): Promise<void> => {
        try {
          await reviewAll(
            input.userId,
            input.sessions.map((session) => session.sessionId),
            log,
          )
          await findFixes(input.userId, log)
        } catch (error) {
          log.error({ err: error }, "review batch stopped unexpectedly")
        }
        update(input.userId, (batch) => ({ ...batch, status: "done" }))
        log.info("review batch done")
      })()
      return { batchId, finished }
    },
    current: (userId) => batches.get(userId),
  }
}
