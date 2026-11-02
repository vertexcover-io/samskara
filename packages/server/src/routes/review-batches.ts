import { zValidator } from "@hono/zod-validator"
import { Hono } from "hono"
import { z } from "zod"
import type { Db } from "../db/client.js"
import { type Env, hasCredential } from "../lib/env.js"
import { type AuthVariables, requireAuth } from "../lib/require-auth.js"
import { canWrite, projectNames } from "../repositories/projects.repo.js"
import { visibleSessionProjectId } from "../repositories/reviews.repo.js"
import {
  type BatchProjectState,
  type BatchSessionState,
  MAX_REVIEW_BATCH_SESSIONS,
  type ReviewBatch,
  type ReviewBatchRegistry,
} from "../services/review-batch/batch.js"

type Deps = {
  readonly db: Db
  readonly env: Env
  readonly reviewBatches: ReviewBatchRegistry
  /** Where the reviewer credential is read from; production is the real environment. */
  readonly credentialEnv?: NodeJS.ProcessEnv
}

const startBodySchema = z
  .object({ sessionIds: z.array(z.string().min(1)).min(1).max(MAX_REVIEW_BATCH_SESSIONS) })
  .strict()

/*
 * Plain objects with the state unions written out, so the hono client's inferred types never
 * name the service module's aliases: the web package cannot import them, and its typecheck
 * fails with TS2742 when they leak.
 */
const sessionState = (
  state: BatchSessionState,
): "waiting" | "reviewing" | "reviewed" | "skipped" | "failed" | "notAllowed" => state

const projectState = (state: BatchProjectState): "waiting" | "running" | "done" | "failed" => state

const batchStatus = (status: ReviewBatch["status"]): "running" | "done" => status

const serializeBatch = (batch: ReviewBatch) => ({
  batchId: batch.batchId,
  status: batchStatus(batch.status),
  startedAt: batch.startedAt,
  sessions: batch.sessions.map((session) => ({
    sessionId: session.sessionId,
    projectId: session.projectId,
    state: sessionState(session.state),
    reason: session.reason,
  })),
  projects: batch.projects.map((project) => ({
    projectId: project.projectId,
    name: project.name,
    state: projectState(project.state),
    reason: project.reason,
  })),
})

/**
 * Review selected sessions, then find fixes for their projects. Its own base: a static GET under
 * /api/sessions would be read as a session id by the `/:id` detail route.
 */
export const reviewBatchRoutes = ({ db, env, reviewBatches, credentialEnv }: Deps) =>
  new Hono<{ Variables: AuthVariables }>()
    .post(
      "/",
      requireAuth({ db, env }, ["web"]),
      zValidator("json", startBodySchema, (result, c) => {
        if (result.success) return
        const tooMany = result.error.issues.some((issue) => issue.code === "too_big")
        return c.json({ error: tooMany ? "tooManySessions" : "invalidReviewBatch" }, 400)
      }),
      async (c) => {
        const userId = c.get("user").id
        if (reviewBatches.current(userId)?.status === "running")
          return c.json({ error: "reviewBatchAlreadyRunning" }, 409)
        if (!hasCredential(env.aiReviewHarness, credentialEnv ?? process.env))
          return c.json({ error: "harnessUnauthenticated" }, 400)
        const sessionIds = [...new Set(c.req.valid("json").sessionIds)]
        // The same gate as Analyze: the session is visible, and its project editable.
        const checked = await Promise.all(
          sessionIds.map(async (sessionId) => {
            const projectId = await visibleSessionProjectId(db, userId, sessionId)
            const allowed = projectId !== null && (await canWrite(db, userId, projectId))
            return { sessionId, projectId: allowed ? projectId : null }
          }),
        )
        const sessions = checked.flatMap((entry) =>
          entry.projectId === null
            ? []
            : [{ sessionId: entry.sessionId, projectId: entry.projectId }],
        )
        const notAllowed = checked
          .filter((entry) => entry.projectId === null)
          .map((entry) => entry.sessionId)
        const names = await projectNames(db, [
          ...new Set(sessions.map((session) => session.projectId)),
        ])
        const started = reviewBatches.start({ userId, sessions, notAllowed, projectNames: names })
        if ("error" in started) return c.json({ error: "reviewBatchAlreadyRunning" }, 409)
        return c.json({ batchId: started.batchId, notAllowed }, 202)
      },
    )
    .get("/current", requireAuth({ db, env }, ["web"]), (c) => {
      const batch = reviewBatches.current(c.get("user").id)
      return c.json({ batch: batch === undefined ? null : serializeBatch(batch) }, 200)
    })
