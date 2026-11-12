import { spawnSync } from "node:child_process"
import { zValidator } from "@hono/zod-validator"
import { hostCommandFor } from "@samskara/core"
import { Hono } from "hono"
import { z } from "zod"
import type { Db } from "../db/client.js"
import {
  DEFAULT_REVIEW_MODEL,
  type Env,
  hasCredential,
  REVIEW_HARNESSES,
  REVIEW_MODEL_PATTERN,
  type ReviewHarness,
} from "../lib/env.js"
import { type AuthVariables, requireAuth } from "../lib/require-auth.js"
import { canWrite } from "../repositories/projects.repo.js"
import {
  listProblemsForSession,
  type ReviewProblemRow,
} from "../repositories/reviewProblems.repo.js"
import {
  hasNewMessagesSince,
  latestDoneRun,
  listReviewsForSession,
  visibleSessionProjectId,
} from "../repositories/reviews.repo.js"
import {
  activeReview,
  queueReview,
  reviewJob,
  unfinishedReview,
} from "../repositories/workQueue.repo.js"
import { type AiReviewErrorCode, PROBLEMS_ANALYZER } from "../services/ai-review/pipeline.js"

type Deps = {
  readonly db: Db
  readonly env: Env
}

/** The ai-review additions: how to wake the worker once a review is queued. */
type AiReviewDeps = Deps & {
  readonly notifyWorker: () => void
  /** Test seam for the reviewer-options availability probe; production shells out to `which`. */
  readonly commandExists?: (command: string) => boolean
  /** Where credentials are read from; production is the real environment. */
  readonly credentialEnv?: NodeJS.ProcessEnv
}

/**
 * The running-job shape both job-bearing endpoints return, built from the review row. A row
 * waiting between tries is still running to the person who asked. Plain literals, so the hono
 * client's inferred types never reach into service modules.
 */
const serializeRunningJob = (row: { readonly id: string; readonly updatedAt: Date }) => ({
  jobId: row.id,
  status: "running" as const,
  startedAt: row.updatedAt.toISOString(),
  lastEvent: null as { readonly name: string; readonly at: string } | null,
})

/**
 * When the run's result was written. A run's row is written once, so updatedAt is its finish
 * time; an AI review's own recorded finish time wins when it has one.
 */
const analyzedAt = (row: { readonly signals: unknown; readonly updatedAt: Date }): string =>
  new Date(
    (row.signals as { run?: { finishedAt?: string } } | null)?.run?.finishedAt ?? row.updatedAt,
  ).toISOString()

/** A saved problem as the session page reads it. */
const serializeProblem = (problem: ReviewProblemRow) => ({
  id: problem.id,
  title: problem.title,
  class: problem.class,
  severity: problem.severity,
  severityReason: problem.severityReason,
  fixType: problem.fixType,
  description: problem.description,
  evidence: problem.evidence,
  learning: problem.learning,
  extra: problem.extra,
})

/** A job that failed all its tries, with its saved reason split into the web's code and message. */
const serializeFailedJob = (row: { readonly id: string; readonly error: string | null }) => {
  const failed = splitReviewError(row.error)
  return {
    status: "failed" as const,
    jobId: row.id,
    code: failed.code,
    detail: { message: failed.message } as unknown,
  }
}

const ERROR_CODES: ReadonlyArray<AiReviewErrorCode> = [
  "sessionNotFound",
  "notEditable",
  "harnessUnauthenticated",
  "harnessFailed",
  "deliverableMissing",
  "unparseable",
  "promptMergeFailed",
]

/** A failed row's `error` is `code: message`; the code the web maps to words, and the message. */
const splitReviewError = (error: string | null): { code: string; message: string } => {
  const [head = "", ...rest] = (error ?? "").split(": ")
  const known = (ERROR_CODES as ReadonlyArray<string>).includes(head)
  return known
    ? { code: head, message: rest.join(": ") }
    : { code: "harnessFailed", message: error ?? "" }
}

/** A user prompt is instructions, not a document: this is room for a long one. */
const MAX_USER_PROMPT_CHARS = 20_000

const analyzeBodySchema = z
  .object({
    harness: z.enum(REVIEW_HARNESSES).optional(),
    // The charset is the guard, not just the quoting: this value reaches the msb runner's
    // in-guest shell command, and the guest has the workspace mounted at /work.
    model: z.string().trim().min(1).max(100).regex(REVIEW_MODEL_PATTERN).optional(),
    /**
     * `full` reads the whole session; `newMessages` reads only what the newest done run did not,
     * and is refused when there is nothing new. Every run is a new row.
     */
    mode: z.enum(["full", "newMessages"]).optional(),
    /** The user's own review prompt, any shape; merged into the review's base instructions. */
    prompt: z.string().trim().min(1).max(MAX_USER_PROMPT_CHARS).optional(),
  })
  .strict()
  .optional()

/** Best-effort "is this CLI on the machine" — the reviewer-options availability probe. */
const defaultCommandExists = (command: string): boolean =>
  spawnSync("which", [command], { stdio: "ignore" }).status === 0

/**
 * The modal's data, on its own base (not under /api/sessions — a static path there would be
 * captured by the `/:id` detail route): which reviewer harnesses this server can run, each
 * with its default model, known model list, and whether its CLI is installed on the host.
 * Web-only — the CLI keeps using the env defaults and never renders a choice.
 */
export const reviewerOptionsRoutes = ({
  db,
  env,
  commandExists,
  credentialEnv,
}: Pick<AiReviewDeps, "db" | "env" | "commandExists" | "credentialEnv">) =>
  new Hono<{ Variables: AuthVariables }>().get("/", requireAuth({ db, env }, ["web"]), (c) => {
    const exists = commandExists ?? defaultCommandExists
    const curated: Readonly<Record<ReviewHarness, ReadonlyArray<string>>> = {
      opencode: [DEFAULT_REVIEW_MODEL.opencode],
      claude: [DEFAULT_REVIEW_MODEL.claude, "opus", "haiku"],
    }
    // Available means runnable: the CLI is installed AND this deployment holds a credential
    // for it. Offering a harness that can only fail auth is how a user spends a job slot to
    // learn what the server already knew.
    const credentials = credentialEnv ?? process.env
    const harnesses = REVIEW_HARNESSES.map((harness) => ({
      harness,
      defaultModel: DEFAULT_REVIEW_MODEL[harness],
      available:
        exists(hostCommandFor(harness, credentials)) && hasCredential(harness, credentials),
      models: [
        ...new Set([
          ...curated[harness],
          ...(env.aiReviewHarness === harness ? [env.aiReviewModel] : []),
        ]),
      ],
    }))
    return c.json(
      {
        defaultHarness: env.aiReviewHarness,
        defaultModel: env.aiReviewModel,
        harnesses,
      },
      200,
    )
  })

export const reviewRoutes = ({ db, env, notifyWorker, credentialEnv }: AiReviewDeps) =>
  new Hono<{ Variables: AuthVariables }>()
    .get("/:id/review", requireAuth({ db, env }, ["web", "cli"]), async (c) => {
      const rows = await listReviewsForSession(db, c.get("user").id, c.req.param("id"))
      return c.json(
        {
          reviews: rows.map(
            (row: {
              id: string
              analyzer: string
              outcome: string
              summary: string
              signals: unknown
              createdAt: Date
              updatedAt: Date
            }) => ({
              id: row.id,
              analyzer: row.analyzer,
              outcome: row.outcome,
              summary: row.summary,
              signals: row.signals,
              createdAt: new Date(row.createdAt).toISOString(),
              analyzedAt: analyzedAt(row),
            }),
          ),
        },
        200,
      )
    })
    /**
     * Queue a harness-run AI review for the worker as a new run. Editor-gated, then refused
     * synchronously when the chosen harness has no credential. A run already waiting or running
     * for this session answers 409 analysisAlreadyRunning (join it via GET /:id/aireview's `job`
     * field). `mode: "newMessages"` continues from the newest done run and answers 400
     * nothingNew when there is none or nothing came after it. Otherwise 202 with the new row's
     * id as `jobId`, and the caller polls.
     */
    .post(
      "/:id/analyze",
      requireAuth({ db, env }, ["web", "cli"]),
      zValidator("json", analyzeBodySchema, (result, c) => {
        if (result.success) return
        c.get("log")?.warn(
          { issues: result.error.issues.map((issue) => issue.path.join(".")) },
          "analyze body validation failed",
        )
        const field = result.error.issues[0]?.path[0]
        const codes: Record<string, string> = {
          harness: "invalidHarness",
          model: "invalidModel",
          mode: "invalidMode",
          prompt: "invalidPrompt",
        }
        return c.json({ error: codes[String(field)] ?? "invalidAnalyzeBody" }, 400)
      }),
      async (c) => {
        const sessionId = c.req.param("id")
        const userId = c.get("user").id
        // The project id is all this handler needs; the pipeline loads the transcript itself.
        const projectId = await visibleSessionProjectId(db, userId, sessionId)
        if (projectId === null) return c.json({ error: "sessionNotFound" }, 404)
        const allowed = await canWrite(db, userId, projectId)
        if (!allowed) return c.json({ error: "notEditable" }, 403)
        const harness = c.req.valid("json")?.harness ?? env.aiReviewHarness
        if (!hasCredential(harness, credentialEnv ?? process.env))
          return c.json({ error: "harnessUnauthenticated" }, 400)
        if ((await activeReview(db, sessionId, PROBLEMS_ANALYZER)) !== null)
          return c.json({ error: "analysisAlreadyRunning" }, 409)
        const body = c.req.valid("json")
        const base =
          body?.mode === "newMessages"
            ? await latestDoneRun(db, sessionId, PROBLEMS_ANALYZER)
            : null
        if (
          body?.mode === "newMessages" &&
          (base === null || !(await hasNewMessagesSince(db, sessionId, base.id)))
        )
          return c.json({ error: "nothingNew" }, 400)
        const queued = await queueReview(db, {
          sessionId,
          projectId,
          analyzer: PROBLEMS_ANALYZER,
          ...(base === null ? {} : { basedOn: base.id }),
          options: {
            ...(body?.harness === undefined ? {} : { harness: body.harness }),
            ...(body?.model === undefined ? {} : { model: body.model }),
            ...(body?.prompt === undefined ? {} : { prompt: body.prompt }),
          },
        })
        // Null is a second click winning the race the guard above can only narrow: same 409.
        if (queued === null) return c.json({ error: "analysisAlreadyRunning" }, 409)
        notifyWorker()
        return c.json({ jobId: queued.id }, 202)
      },
    )
    /**
     * Job status, read from the review row the job id names: the one way a caller can see why
     * an analysis never landed.
     */
    .get("/:id/analyze/:jobId", requireAuth({ db, env }, ["web", "cli"]), async (c) => {
      const sessionId = c.req.param("id")
      // Visibility first: a failed job's `detail` carries the harness's own error text.
      if ((await visibleSessionProjectId(db, c.get("user").id, sessionId)) === null)
        return c.json({ error: "jobNotFound" }, 404)
      const jobId = c.req.param("jobId")
      const row = z.string().uuid().safeParse(jobId).success
        ? await reviewJob(db, sessionId, jobId)
        : null
      if (row === null) return c.json({ error: "jobNotFound" }, 404)
      // Plain literals, so the hono client's inferred types stay portable.
      const body =
        row.status === "done"
          ? { status: "succeeded" as const, jobId: row.id, reviewId: row.id }
          : row.status === "failed"
            ? serializeFailedJob(row)
            : { ...serializeRunningJob(row), sessionId }
      return c.json({ job: body }, 200)
    })
    /**
     * The session's AI review with every problem it saved, visibility-scoped by the same join
     * as GET /:id/review. While a review for this session is waiting or running, the response
     * also carries it as `job` beside any earlier result (review: null for a first review) —
     * that is what lets a reloaded page rejoin a run it started before the reload. A review whose
     * last tries all failed is the `job` too, as failed with its reason, until a try succeeds.
     */
    .get("/:id/aireview", requireAuth({ db, env }, ["web", "cli"]), async (c) => {
      const sessionId = c.req.param("id")
      const userId = c.get("user").id
      // `listReviewsForSession` carries the visibility join, but the job lookup below does not
      // — so the session is gated explicitly before either is consulted.
      if ((await visibleSessionProjectId(db, userId, sessionId)) === null)
        return c.json({ error: "noAiReview" }, 404)
      const rows = await listReviewsForSession(db, userId, sessionId)
      const chain = rows.filter((review) => review.analyzer === PROBLEMS_ANALYZER)
      const job = await unfinishedReview(db, sessionId, PROBLEMS_ANALYZER)
      if (chain.length === 0 && job === null) return c.json({ error: "noAiReview" }, 404)
      const problems =
        chain.length === 0
          ? []
          : await listProblemsForSession(
              db,
              userId,
              sessionId,
              chain.map((run) => run.id),
            )
      const runs = chain.map((run) => ({
        id: run.id,
        kind: run.newPartOnly ? ("newPart" as const) : ("full" as const),
        createdAt: new Date(run.createdAt).toISOString(),
        analyzedAt: analyzedAt(run),
        outcome: run.outcome,
        summary: run.summary,
        signals: run.signals,
        problems: problems.filter((problem) => problem.reviewId === run.id).map(serializeProblem),
      }))
      const newest = runs[0]
      // The newest shown run is the newest done run: the same base `mode: "newMessages"` uses.
      const newMessages =
        newest === undefined ? false : await hasNewMessagesSince(db, sessionId, newest.id)
      return c.json(
        {
          newMessages,
          review:
            newest === undefined
              ? null
              : {
                  id: newest.id,
                  createdAt: newest.createdAt,
                  analyzedAt: newest.analyzedAt,
                  outcome: newest.outcome,
                  summary: newest.summary,
                  signals: newest.signals,
                  problems: newest.problems,
                },
          runs,
          ...(job === null
            ? {}
            : {
                job: job.status === "failed" ? serializeFailedJob(job) : serializeRunningJob(job),
              }),
        },
        200,
      )
    })
