import { spawnSync } from "node:child_process"
import { zValidator } from "@hono/zod-validator"
import { Hono } from "hono"
import { z } from "zod"
import type { Db } from "../db/client.js"
import { DEFAULT_REVIEW_MODEL, type Env } from "../lib/env.js"
import { type AuthVariables, requireAuth } from "../lib/require-auth.js"
import { validate } from "../lib/validate.js"
import { canWrite } from "../repositories/projects.repo.js"
import {
  getLearning,
  type LearningRow,
  listCommonLearnings,
  listLearnings,
  listLearningsForSession,
  listReviewsForSession,
  setLearningStatus,
  visibleSessionProjectId,
} from "../repositories/reviews.repo.js"
import { getDetail } from "../repositories/sessions.repo.js"
import type { AiReviewJobRegistry } from "../services/ai-review/jobs.js"
import type { HarnessRunner } from "../services/ai-review/runner.js"
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
}

const serializeLearning = (row: LearningRow) => ({
  id: row.id,
  projectId: row.projectId,
  audience: row.audience,
  category: row.category,
  title: row.title,
  detail: row.detail,
  evidence: row.evidence,
  fingerprint: row.fingerprint,
  status: row.status,
  occurrenceCount: row.occurrenceCount,
  firstSeenAt: new Date(row.firstSeenAt).toISOString(),
  lastSeenAt: new Date(row.lastSeenAt).toISOString(),
})

const audienceSchema = z.enum(["agent", "human"])
const statusSchema = z.enum(["candidate", "accepted", "superseded"])

/** The per-run reviewer choice the modal posts; absent fields keep the env defaults. */
const analyzeBodySchema = z
  .object({
    harness: z.enum(["opencode", "claude"]).optional(),
    model: z.string().trim().min(1).max(100).optional(),
    /** Replace an existing ai-v1 review — the Redo path. The upsert supersedes in place. */
    force: z.boolean().optional(),
  })
  .strict()
  .optional()

export const learningsRoutes = ({ db, env }: Deps) =>
  new Hono<{ Variables: AuthVariables }>()
    // The curation surface: the web UI reads this to list lessons per project, the CLI reads
    // it for `learn`. Visibility comes from the join inside listLearnings — a caller with no
    // project filter still only sees learnings from projects they can open.
    .get("/", requireAuth({ db, env }, ["web", "cli"]), async (c) => {
      const audienceRaw = c.req.query("audience")
      const statusRaw = c.req.query("status")
      const audience = audienceRaw === undefined ? undefined : audienceSchema.parse(audienceRaw)
      const status = statusRaw === undefined ? undefined : statusSchema.parse(statusRaw)
      const rows = await listLearnings(db, c.get("user").id, {
        projectId: c.req.query("projectId"),
        audience,
        status,
      })
      return c.json({ learnings: rows.map(serializeLearning) }, 200)
    })
    /** The cross-project view: same lesson in two or more visible projects. */
    .get("/common", requireAuth({ db, env }, ["web", "cli"]), async (c) => {
      const rows = await listCommonLearnings(db, c.get("user").id)
      return c.json({ learnings: rows }, 200)
    })
    /**
     * Human-check-only promotion (owner ruling 2026-08-26): this route is the one place a
     * lesson's status moves, and only a project editor (or owner/admin) may move it.
     */
    .patch(
      "/:id/status",
      requireAuth({ db, env }, ["web", "cli"]),
      validate("json", z.object({ status: statusSchema }).strict()),
      async (c) => {
        const { status } = c.req.valid("json")
        const existing = await getLearning(db, c.req.param("id"))
        if (existing === null) return c.json({ error: "learningNotFound" }, 404)
        const allowed = await canWrite(db, c.get("user").id, existing.projectId)
        if (!allowed) return c.json({ error: "projectForbidden" }, 403)
        const row = await setLearningStatus(db, existing.id, status)
        if (row === null) return c.json({ error: "learningNotFound" }, 404)
        return c.json({ learning: serializeLearning(row) }, 200)
      },
    )

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
}: Pick<AiReviewDeps, "db" | "env" | "commandExists">) =>
  new Hono<{ Variables: AuthVariables }>().get("/", requireAuth({ db, env }, ["web"]), (c) => {
    const exists = commandExists ?? defaultCommandExists
    const curated: Readonly<Record<"opencode" | "claude", ReadonlyArray<string>>> = {
      opencode: [DEFAULT_REVIEW_MODEL.opencode],
      claude: [DEFAULT_REVIEW_MODEL.claude, "opus", "haiku"],
    }
    const harnesses = (["opencode", "claude"] as const).map((harness) => ({
      harness,
      defaultModel: DEFAULT_REVIEW_MODEL[harness],
      available: exists(harness),
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

export const reviewRoutes = ({ db, env, aiReviewRunner, aiReviewJobs }: AiReviewDeps) =>
  new Hono<{ Variables: AuthVariables }>()
    /** Reviewing is a write (it persists learnings), so `web` and `cli` both may trigger it. */
    .post("/:id/review", requireAuth({ db, env }, ["web", "cli"]), async (c) => {
      const result = await reviewAndPersist(db, c.get("user").id, c.req.param("id"))
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
     * The per-session lessons view behind the web Review tab: learnings whose latest provenance
     * is this session. Reading is a `web` and `cli` capability like every other sessions subpath.
     */
    .get("/:id/learnings", requireAuth({ db, env }, ["web", "cli"]), async (c) => {
      const sessionId = c.req.param("id")
      const projectId = await visibleSessionProjectId(db, c.get("user").id, sessionId)
      if (projectId === null) return c.json({ error: "sessionNotFound" }, 404)
      const rows = await listLearningsForSession(db, c.get("user").id, sessionId)
      return c.json({ learnings: rows.map(serializeLearning) }, 200)
    })
    /**
     * Start a harness-run AI review. Editor-gated up front (the run writes learnings), then
     * conflict-guarded: a job already running for this session answers 409
     * analysisAlreadyRunning (join it via GET /:id/aireview's `job` field rather than spawn a
     * duplicate), and a landed ai-v1 review answers 409 analysisAlreadyExists (no force flag
     * in v1 — re-running after a *failed* job is the path that matters, and failed is
     * terminal so it never blocks). Otherwise handed to the job registry — 202, the caller
     * polls and reads GET /:id/aireview when the ai-v1 row lands.
     *
     * The body optionally carries the per-run reviewer choice from the modal; an absent or
     * empty body keeps the env-driven defaults, which is the CLI's path.
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
        }
        return c.json({ error: codes[String(field)] ?? "invalidAnalyzeBody" }, 400)
      }),
      async (c) => {
        const sessionId = c.req.param("id")
        const userId = c.get("user").id
        const detail = await getDetail(db, userId, sessionId)
        if (detail === null) return c.json({ error: "sessionNotFound" }, 404)
        const allowed = await canWrite(db, userId, detail.session.projectId)
        if (!allowed) return c.json({ error: "notEditable" }, 403)
        if (aiReviewJobs.activeJobForSession(sessionId) !== undefined)
          return c.json({ error: "analysisAlreadyRunning" }, 409)
        const rows = await listReviewsForSession(db, userId, sessionId)
        const hasReview = rows.some((review) => review.analyzer === "ai-v1")
        // A landed review blocks a re-run unless the caller asked to redo — the pipeline's
        // upsert supersedes the old row in place, so a redo replaces rather than duplicates.
        if (hasReview && c.req.valid("json")?.force !== true)
          return c.json({ error: "analysisAlreadyExists" }, 409)
        const started = aiReviewJobs.startAiReviewJob(
          { db, runner: aiReviewRunner, env, log: c.get("log") },
          userId,
          sessionId,
          c.req.valid("json") ?? {},
        )
        if ("error" in started) return c.json({ error: "busy" }, 503)
        return c.json({ jobId: started.jobId }, 202)
      },
    )
    /**
     * Job status: the one way a caller can see why an analysis never landed (v1 registry is
     * in-memory, so a restart loses it — the persisted row is the durable record on success).
     */
    .get("/:id/analyze/:jobId", requireAuth({ db, env }, ["web", "cli"]), (c) => {
      const job = aiReviewJobs.getAiReviewJob(c.req.param("jobId"))
      // Only the running variant carries its sessionId; settled jobs are matched by the
      // unguessable jobId alone. Serialized to plain shapes so the hono client's inferred
      // types stay portable (the registry's types reach into service modules).
      if (job === undefined || ("sessionId" in job && job.sessionId !== c.req.param("id")))
        return c.json({ error: "jobNotFound" }, 404)
      const body =
        job.status === "succeeded"
          ? { status: job.status, jobId: job.jobId, reviewId: job.reviewId }
          : job.status === "failed"
            ? { status: job.status, jobId: job.jobId, code: job.code as string, detail: job.detail }
            : {
                status: job.status,
                jobId: job.jobId,
                sessionId: job.sessionId,
                startedAt: job.startedAt,
                lastEvent:
                  job.lastEvent === null
                    ? null
                    : { name: job.lastEvent.name, at: job.lastEvent.at },
              }
      return c.json({ job: body }, 200)
    })
    /**
     * The persisted ai-v1 review, visibility-scoped by the same join as GET /:id/review; the
     * ai-v1 analyzer row is picked out client-side from the session's scoped review list.
     * While a job for this session is in flight, the response also carries it as `job`
     * (review: null until the row lands) — that is what lets a reloaded page rejoin a run
     * it started before the reload, the registry being in-memory and the page stateless.
     */
    .get("/:id/aireview", requireAuth({ db, env }, ["web", "cli"]), async (c) => {
      const sessionId = c.req.param("id")
      const rows = await listReviewsForSession(db, c.get("user").id, sessionId)
      const row = rows.find((review) => review.analyzer === "ai-v1")
      const job = aiReviewJobs.activeJobForSession(sessionId)
      if (row === undefined && job === undefined) return c.json({ error: "noAiReview" }, 404)
      return c.json(
        {
          review:
            row === undefined
              ? null
              : {
                  id: row.id,
                  createdAt: new Date(row.createdAt).toISOString(),
                  // A redo replaces the row in place, so createdAt stays the original's —
                  // updatedAt is when the current verdict was actually written.
                  analyzedAt: new Date(row.updatedAt).toISOString(),
                  outcome: row.outcome,
                  friction: row.friction,
                  summary: row.summary,
                  signals: row.signals,
                },
          ...(job === undefined
            ? {}
            : {
                job: {
                  jobId: job.jobId,
                  status: job.status,
                  startedAt: job.startedAt,
                  lastEvent:
                    job.lastEvent === null
                      ? null
                      : { name: job.lastEvent.name, at: job.lastEvent.at },
                },
              }),
        },
        200,
      )
    })
