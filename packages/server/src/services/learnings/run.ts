import { basename, join, resolve } from "node:path"
import {
  groupProblems,
  type HarnessRunner,
  type LearningInput,
  type ProblemInput,
  problemExcerpt,
  recordsInReviewOrder,
  withHarnessSnapshot,
  writeLearnings,
  writerGroupId,
} from "@samskara/core"
import type pino from "pino"
import type { Db } from "../../db/client.js"
import type { Env } from "../../lib/env.js"
import * as learningsRepo from "../../repositories/learnings.repo.js"
import { sessionMessages } from "../../repositories/sessions.repo.js"
import { reviewSessionExport } from "../ai-review/sessionExport.js"
import { LEARNING_RUNS_DIR, openRunLog, type RunLog } from "./runLog.js"

export type LearningRunDeps = {
  readonly db: Db
  readonly runner: HarnessRunner
  readonly env: Env
  readonly log: pino.Logger
  /** Where run logs go; `.samskara/learning-runs` under the working directory by default. */
  readonly logDir?: string
}

export type LearningRunOptions = {
  /** A local checkout of the harness; its committed code is what each learning is checked against. */
  readonly harnessPath: string
  /** Problems per batch. Agent 1 reads a whole batch at once, so this keeps its input small. */
  readonly batchSize?: number
  /** New high and medium learnings this run may make; `PRIORITY_LIMITS` when absent. */
  readonly priorityLimits?: { readonly high: number; readonly medium: number }
}

/** About 150K characters of problems: one agent reads that comfortably. */
export const LEARNING_BATCH_SIZE = 100

/**
 * How many new learnings one run may make at high and at medium priority; low has no limit,
 * and learnings a run updates do not count. Agent 2 is told what is left, batch by batch.
 */
export const PRIORITY_LIMITS = { high: 5, medium: 8 } as const

/** A first run over a long history stops here; the next run picks up the rest. */
const MAX_BATCHES = 40

type PriorityCount = { high: number; medium: number }

/** The model both learning agents run on: `LEARNINGS_MODEL`, else the reviewer's own. */
const learningsModelOf = (env: Env): string => env.learningsModel ?? env.aiReviewModel

export type StartedLearningRun =
  | { readonly status: "busy" }
  | {
      readonly status: "started"
      readonly runId: string
      readonly finished: Promise<"done" | "failed">
    }

/**
 * Starts a learning run for the org and returns as soon as its row exists; `finished` settles
 * when it ends and never rejects. Busy when the org already has one running.
 */
export const startLearningRun = async (
  deps: LearningRunDeps,
  orgId: string,
  options: LearningRunOptions,
): Promise<StartedLearningRun> => {
  const run = await learningsRepo.startRun(deps.db, orgId)
  if (run === null) return { status: "busy" }
  const log = deps.log.child({ learningRunId: run.id, orgId })
  const finished = (async (): Promise<"done" | "failed"> => {
    const runLog = await openRunLog(
      deps.logDir ?? join(process.cwd(), LEARNING_RUNS_DIR),
      run.id,
      log,
    )
    runLog.event("run.start", {
      orgId,
      harnessPath: options.harnessPath,
      harness: deps.env.aiReviewHarness,
      model: learningsModelOf(deps.env),
    })
    let outcome: learningsRepo.RunOutcome
    try {
      await work(deps, log, runLog, run.id, orgId, options)
      outcome = { status: "done" }
    } catch (error) {
      log.warn({ err: error }, "learning run failed")
      outcome = { status: "failed", error: error instanceof Error ? error.message : String(error) }
    }
    runLog.event("run.end", outcome)
    await runLog.close()
    try {
      await learningsRepo.finishRun(deps.db, run.id, outcome)
    } catch (error) {
      // The row stays `running` and blocks the org until the next restart fails it
      // (`failInterruptedRuns`); say so rather than reject a promise nobody may await.
      log.error({ err: error }, "learning run could not be marked finished")
      return "failed"
    }
    if (outcome.status === "done") log.info("learning run done")
    return outcome.status
  })()
  return { status: "started", runId: run.id, finished }
}

/** A whole run, start to end, awaited: for scripts and tests. The routes and the schedule start one. */
export const runLearnings = async (
  deps: LearningRunDeps,
  orgId: string,
  options: LearningRunOptions,
): Promise<
  { readonly status: "busy" } | { readonly status: "done" | "failed"; readonly runId: string }
> => {
  const started = await startLearningRun(deps, orgId, options)
  if (started.status === "busy") return started
  return { status: await started.finished, runId: started.runId }
}

/**
 * Batch after batch until no problem is left unmarked, against one snapshot of the harness. A
 * batch that fails stops the run with nothing of that batch saved, so its problems are read
 * again next time.
 */
const work = async (
  deps: LearningRunDeps,
  log: pino.Logger,
  runLog: RunLog,
  runId: string,
  orgId: string,
  options: LearningRunOptions,
): Promise<void> => {
  // Nothing to do costs no snapshot and no agent.
  if ((await learningsRepo.unmarkedProblems(deps.db, orgId, 1)).length === 0) {
    runLog.event("run.nothing_to_do")
    return
  }
  await withHarnessSnapshot(options.harnessPath, async (harness) => {
    const harnessRef = `${basename(resolve(options.harnessPath))}@${harness.ref.slice(0, 12)}`
    await learningsRepo.setHarnessRef(deps.db, runId, harnessRef)
    runLog.event("harness.snapshot", { harnessRef })
    const limits = options.priorityLimits ?? PRIORITY_LIMITS
    const used: PriorityCount = { high: 0, medium: 0 }
    for (let batch = 1; batch <= MAX_BATCHES; batch += 1) {
      const counted = await runBatch(deps, {
        batch,
        runId,
        orgId,
        harnessDir: harness.dir,
        batchSize: options.batchSize ?? LEARNING_BATCH_SIZE,
        left: { high: limits.high - used.high, medium: limits.medium - used.medium },
        trace: (step, fields = {}) => runLog.event(step, { batch, ...fields }),
        log,
      })
      if (counted === null) return
      used.high += counted.high
      used.medium += counted.medium
    }
  })
}

/**
 * One batch: agent 1 groups the oldest unmarked problems by cause, joining learnings already
 * found; agent 2 checks each group against the harness and its evidence and writes it up or
 * drops it; then the batch is saved in one transaction. Returns how many new high and medium
 * learnings it made, or null when no problem was left.
 */
const runBatch = async (
  deps: LearningRunDeps,
  input: {
    readonly batch: number
    readonly runId: string
    readonly orgId: string
    readonly harnessDir: string
    readonly batchSize: number
    /** New high and medium learnings the run may still make. */
    readonly left: PriorityCount
    readonly trace: (step: string, fields?: Readonly<Record<string, unknown>>) => void
    readonly log: pino.Logger
  },
): Promise<PriorityCount | null> => {
  const { db, runner, env } = deps
  const { trace } = input
  const choice = { harness: env.aiReviewHarness, model: learningsModelOf(env) }
  const problems = await learningsRepo.unmarkedProblems(db, input.orgId, input.batchSize)
  if (problems.length === 0) return null
  const known = await learningsRepo.learningsForGrouping(db, input.orgId)
  trace("batch.start", {
    problems: problems.length,
    learningsSoFar: known.length,
    priorityLeft: input.left,
  })

  const grouped = await groupProblems({ problems, learnings: known, runner, run: choice, trace })
  if (!grouped.ok) throw new Error(`grouping failed: ${grouped.errors.join("; ")}`)

  const joined = new Map(
    (
      await learningsRepo.learningsWithProblems(
        db,
        grouped.groups.flatMap((group) => (group.learningId === null ? [] : [group.learningId])),
      )
    ).map((learning) => [learning.id, learning]),
  )
  const byId = new Map((await withExcerpts(db, problems)).map((problem) => [problem.id, problem]))
  const groups = grouped.groups.map((group) => {
    const found = group.learningId === null ? undefined : joined.get(group.learningId)
    const { problems: linked = [], ...existing } = found ?? {}
    return {
      // A joined learning keeps the cause it was found with.
      cause: found?.cause ?? group.cause,
      existing: found === undefined ? null : (existing as LearningInput),
      problems: [...linked, ...group.problemIds.map((id) => byId.get(id) as ProblemInput)],
      learningId: group.learningId,
      newProblemIds: group.problemIds,
    }
  })

  const written = await writeLearnings({
    groups,
    harnessDir: input.harnessDir,
    priorityLimits: input.left,
    runner,
    run: choice,
    trace,
  })
  if (!written.ok) throw new Error(`writing learnings failed: ${written.errors.join("; ")}`)

  const counted: PriorityCount = { high: 0, medium: 0 }
  for (const [index, answer] of written.answers.entries())
    if (
      answer.verdict === "learning" &&
      groups[index]?.existing === null &&
      (answer.priority === "high" || answer.priority === "medium")
    )
      counted[answer.priority] += 1

  const saved = await learningsRepo.saveBatch(db, {
    runId: input.runId,
    orgId: input.orgId,
    groups: groups.map((group, index) => ({
      cause: group.cause,
      learningId: group.learningId,
      problemIds: group.newProblemIds,
      answer: written.answers[index] as (typeof written.answers)[number],
    })),
  })
  trace("batch.saved", {
    groups: saved.map((outcome, index) => {
      const answer = written.answers[index]
      return {
        group: writerGroupId(index),
        action: outcome.action,
        learningId: outcome.learningId,
        problemIds: outcome.problemIds,
        ...(answer?.verdict === "drop" ? { reason: answer.reason } : {}),
        ...(answer?.verdict === "learning" ? { priority: answer.priority } : {}),
      }
    }),
    priorityUsedThisBatch: counted,
  })
  input.log.info(
    {
      batch: input.batch,
      problems: problems.length,
      groups: groups.length,
      dropped: written.answers.filter((answer) => answer.verdict === "drop").length,
    },
    "learning batch saved",
  )
  return counted
}

/**
 * The batch's problems, each with its evidence excerpt: the records it cites and a few on each
 * side, read from the session in the order its review numbered them. Agent 2 judges a drop on
 * these. One read per session; a review that saved no record order gets no excerpts.
 */
const withExcerpts = async (
  db: Db,
  problems: ReadonlyArray<ProblemInput>,
): Promise<ProblemInput[]> => {
  const reviewIds = [...new Set(problems.flatMap((problem) => problem.reviewId ?? []))]
  const excerpts = new Map<string, string>()
  for (const review of await learningsRepo.reviewSessions(db, reviewIds)) {
    if (review.recordIds === null) continue
    const records = recordsInReviewOrder(
      reviewSessionExport({
        session: { id: review.sessionId, title: review.title, source: review.source },
        messages: await sessionMessages(db, review.sessionId),
        full: true,
      }).records,
      review.recordIds,
    )
    for (const problem of problems)
      if (problem.reviewId === review.reviewId)
        excerpts.set(problem.id, problemExcerpt(records, problem.evidence))
  }
  return problems.map((problem) => {
    const excerpt = excerpts.get(problem.id)
    return excerpt === undefined ? problem : { ...problem, excerpt }
  })
}
