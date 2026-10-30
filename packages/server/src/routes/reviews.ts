import { spawnSync } from "node:child_process"
import { zValidator } from "@hono/zod-validator"
import { type HarnessRunner, hostCommandFor } from "@samskara/core"
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
import { listProblemsForSession } from "../repositories/reviewProblems.repo.js"
import { listReviewsForSession, visibleSessionProjectId } from "../repositories/reviews.repo.js"
import type { AiReviewJobRegistry, RunningAiReviewJob } from "../services/ai-review/jobs.js"
import { PROBLEMS_ANALYZER } from "../services/ai-review/pipeline.js"
import { reviewAndPersist } from "../services/review.js"

type Deps = {
  readonly db: Db
  readonly env: Env
}

/** The ai-review additions: the harness bridge plus the app-wide job registry. */
type AiReviewDeps = Deps & {
  readonly aiReviewRunner: HarnessRunner
  readonly aiReviewJobs: AiReviewJobRegistry
  /** Test seam for the reviewer-options availability probe; production shells out to `which`. */
  readonly commandExists?: (command: string) => boolean
  /** Where credentials are read from; production is the real environment. */
  readonly credentialEnv?: NodeJS.ProcessEnv
}

/**
 * The running-job shape both job-bearing endpoints return. Deliberately re-flattened into a
 * plain object rather than passing the registry's type through: hono infers the client's
 * types from these literals, and the registry's types reach into service modules.
 */
const serializeRunningJob = (job: RunningAiReviewJob) => ({
  jobId: job.jobId,
  status: job.status,
  startedAt: job.startedAt,
  lastEvent: job.lastEvent === null ? null : { name: job.lastEvent.name, at: job.lastEvent.at },
})

/** A user prompt is instructions, not a document: this is room for a long one. */
const MAX_USER_PROMPT_CHARS = 20_000

const analyzeBodySchema = z
  .object({
    harness: z.enum(REVIEW_HARNESSES).optional(),
    // The charset is the guard, not just the quoting: this value reaches the msb runner's
    // in-guest shell command, and the guest has the workspace mounted at /work.
    model: z.string().trim().min(1).max(100).regex(REVIEW_MODEL_PATTERN).optional(),
    /** Replace an existing review — the Redo path. Supersedes in place. */
    force: z.boolean().optional(),
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

export const reviewRoutes = ({
  db,
  env,
  aiReviewRunner,
  aiReviewJobs,
  credentialEnv,
}: AiReviewDeps) =>
  new Hono<{ Variables: AuthVariables }>()
    /**
     * Reviewing is a write (it persists the review), so `web` and `cli` both may trigger it —
     * and, like `/analyze`, only a project editor may. Read visibility is not enough: this
     * route rewrites the session's review row, so a viewer-scoped member gated only by
     * `getDetail` could edit a project they are only allowed to read.
     */
    .post("/:id/review", requireAuth({ db, env }, ["web", "cli"]), async (c) => {
      const sessionId = c.req.param("id")
      const userId = c.get("user").id
      const projectId = await visibleSessionProjectId(db, userId, sessionId)
      if (projectId === null) return c.json({ error: "sessionNotFound" }, 404)
      if (!(await canWrite(db, userId, projectId))) return c.json({ error: "notEditable" }, 403)
      const result = await reviewAndPersist(db, userId, sessionId)
      if (result === null) return c.json({ error: "sessionNotFound" }, 404)
      const { review, reviewId } = result
      return c.json(
        {
          reviewId,
          review: {
            sessionId: review.sessionId,
            analyzer: review.analyzer,
            analyzedAt: review.analyzedAt,
            outcome: review.outcome,
            friction: review.friction,
            summary: review.summary,
            signals: review.signals,
            agentLearnings: review.agentLearnings,
            humanFeedback: review.humanFeedback,
          },
        },
        201,
      )
    })
    .get("/:id/review", requireAuth({ db, env }, ["web", "cli"]), async (c) => {
      const rows = await listReviewsForSession(db, c.get("user").id, c.req.param("id"))
      return c.json(
        {
          reviews: rows.map(
            (row: {
              id: string
              analyzer: string
              outcome: string
              friction: string
              summary: string
              signals: unknown
              createdAt: Date
              updatedAt: Date
            }) => ({
              id: row.id,
              analyzer: row.analyzer,
              outcome: row.outcome,
              friction: row.friction,
              summary: row.summary,
              signals: row.signals,
              createdAt: new Date(row.createdAt).toISOString(),
              // A redo replaces the row in place — this is when the current verdict was written.
              analyzedAt: new Date(row.updatedAt).toISOString(),
            }),
          ),
        },
        200,
      )
    })
    /**
     * Start a harness-run AI review. Editor-gated, then refused synchronously when the chosen
     * harness has no credential. A job already running for this session answers 409
     * analysisAlreadyRunning (join it via GET /:id/aireview's `job` field rather than spawn a
     * duplicate); a landed review answers 409 analysisAlreadyExists unless the body
     * sets `force`, which supersedes the row in place. Otherwise 202, and the caller polls.
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
          force: "invalidForce",
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
        if (aiReviewJobs.activeJobForSession(sessionId) !== undefined)
          return c.json({ error: "analysisAlreadyRunning" }, 409)
        const rows = await listReviewsForSession(db, userId, sessionId)
        const body = c.req.valid("json")
        const hasReview = rows.some((review) => review.analyzer === PROBLEMS_ANALYZER)
        // A landed review blocks a re-run unless the caller asked to redo — the pipeline's
        // upsert supersedes the old row in place, so a redo replaces rather than duplicates.
        if (hasReview && body?.force !== true)
          return c.json({ error: "analysisAlreadyExists" }, 409)
        const started = aiReviewJobs.startAiReviewJob(
          {
            db,
            runner: aiReviewRunner,
            env,
            log: c.get("log"),
            ...(credentialEnv === undefined ? {} : { credentialEnv }),
          },
          userId,
          sessionId,
          c.req.valid("json") ?? {},
        )
        // `alreadyRunning` is the registry winning the race the route's own guard above can
        // only narrow: same 409 the sequential path returns, so a double click is idempotent.
        if ("error" in started)
          return started.error === "alreadyRunning"
            ? c.json({ error: "analysisAlreadyRunning" }, 409)
            : c.json({ error: "busy" }, 503)
        return c.json({ jobId: started.jobId }, 202)
      },
    )
    /**
     * Job status: the one way a caller can see why an analysis never landed (v1 registry is
     * in-memory, so a restart loses it — the persisted row is the durable record on success).
     */
    .get("/:id/analyze/:jobId", requireAuth({ db, env }, ["web", "cli"]), async (c) => {
      const sessionId = c.req.param("id")
      // Visibility first: the registry is an in-memory map keyed by an id the caller supplies,
      // so without this a stranger could poll any job. A settled job's `detail` carries harness
      // stderr, a host workspace path and an excerpt of the reviewer's output.
      if ((await visibleSessionProjectId(db, c.get("user").id, sessionId)) === null)
        return c.json({ error: "jobNotFound" }, 404)
      const job = aiReviewJobs.getAiReviewJob(c.req.param("jobId"))
      // Only the running variant carries its sessionId; settled jobs are matched by the
      // unguessable jobId alone. Serialized to plain shapes so the hono client's inferred
      // types stay portable (the registry's types reach into service modules).
      if (job === undefined || ("sessionId" in job && job.sessionId !== sessionId))
        return c.json({ error: "jobNotFound" }, 404)
      const body =
        job.status === "succeeded"
          ? { status: job.status, jobId: job.jobId, reviewId: job.reviewId }
          : job.status === "failed"
            ? { status: job.status, jobId: job.jobId, code: job.code as string, detail: job.detail }
            : { ...serializeRunningJob(job), sessionId: job.sessionId }
      return c.json({ job: body }, 200)
    })
    /**
     * The session's AI review with every problem it saved, visibility-scoped by the same join
     * as GET /:id/review. While a job for this session is in flight, the response also carries
     * it as `job` (review: null until the row lands) — that is what lets a reloaded page rejoin
     * a run it started before the reload, the registry being in-memory and the page stateless.
     */
    .get("/:id/aireview", requireAuth({ db, env }, ["web", "cli"]), async (c) => {
      const sessionId = c.req.param("id")
      const userId = c.get("user").id
      // `listReviewsForSession` carries the visibility join, but the registry lookup below
      // does not — so the session is gated explicitly before either is consulted. Otherwise
      // an in-flight job answered 200 with its jobId for a session the caller cannot see.
      if ((await visibleSessionProjectId(db, userId, sessionId)) === null)
        return c.json({ error: "noAiReview" }, 404)
      const rows = await listReviewsForSession(db, userId, sessionId)
      const row = rows.find((review) => review.analyzer === PROBLEMS_ANALYZER)
      const job = aiReviewJobs.activeJobForSession(sessionId)
      if (row === undefined && job === undefined) return c.json({ error: "noAiReview" }, 404)
      const problems =
        row === undefined ? [] : await listProblemsForSession(db, userId, sessionId, row.id)
      return c.json(
        {
          review:
            row === undefined
              ? null
              : {
                  id: row.id,
                  createdAt: new Date(row.createdAt).toISOString(),
                  // A redo replaces the row in place, so createdAt stays the original's —
                  // updatedAt is when the current review was actually written.
                  analyzedAt: new Date(row.updatedAt).toISOString(),
                  outcome: row.outcome,
                  friction: row.friction,
                  summary: row.summary,
                  signals: row.signals,
                  problems: problems.map((problem) => ({
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
                  })),
                },
          ...(job === undefined ? {} : { job: serializeRunningJob(job) }),
        },
        200,
      )
    })
