import { zValidator } from "@hono/zod-validator"
import { Hono } from "hono"
import { z } from "zod"
import type { Db } from "../db/client.js"
import { type Env, hasCredential } from "../lib/env.js"
import { type AuthVariables, requireAuth } from "../lib/require-auth.js"
import { canWrite } from "../repositories/projects.repo.js"
import { hasReviewFrom, visibleSessionProjectId } from "../repositories/reviews.repo.js"
import { queueFixRun, queueReview } from "../repositories/workQueue.repo.js"
import { PROBLEMS_ANALYZER } from "../services/ai-review/pipeline.js"

/** The most sessions one press of Review takes. */
export const MAX_REVIEW_BATCH_SESSIONS = 50

type Deps = {
  readonly db: Db
  readonly env: Env
  /** Wakes the worker once the reviews are queued. */
  readonly notifyWorker: () => void
  /** Where the reviewer credential is read from; production is the real environment. */
  readonly credentialEnv?: NodeJS.ProcessEnv
}

const startBodySchema = z
  .object({ sessionIds: z.array(z.string().min(1)).min(1).max(MAX_REVIEW_BATCH_SESSIONS) })
  .strict()

/**
 * Review ticked sessions: each one the caller may edit and that has no review yet is queued
 * for the worker, and each project that got a review queued gets a fix run that waits for its
 * reviews to finish. Its own base: a static path under /api/sessions would be read as a session id.
 */
export const reviewBatchRoutes = ({ db, env, notifyWorker, credentialEnv }: Deps) =>
  new Hono<{ Variables: AuthVariables }>().post(
    "/",
    requireAuth({ db, env }, ["web"]),
    zValidator("json", startBodySchema, (result, c) => {
      if (result.success) return
      const tooMany = result.error.issues.some((issue) => issue.code === "too_big")
      return c.json({ error: tooMany ? "tooManySessions" : "invalidReviewBatch" }, 400)
    }),
    async (c) => {
      const userId = c.get("user").id
      if (!hasCredential(env.aiReviewHarness, credentialEnv ?? process.env))
        return c.json({ error: "harnessUnauthenticated" }, 400)
      const sessionIds = [...new Set(c.req.valid("json").sessionIds)]
      // The same gate as Analyze: the session is visible, and its project editable. Edit
      // rights are asked once per project, since 50 sessions usually share one or two.
      const visible = await Promise.all(
        sessionIds.map(async (sessionId) => ({
          sessionId,
          projectId: await visibleSessionProjectId(db, userId, sessionId),
        })),
      )
      const projectIds = [
        ...new Set(visible.flatMap((entry) => (entry.projectId === null ? [] : [entry.projectId]))),
      ]
      const editable = new Set(
        (
          await Promise.all(
            projectIds.map(async (projectId) =>
              (await canWrite(db, userId, projectId)) ? [projectId] : [],
            ),
          )
        ).flat(),
      )
      const notAllowed: string[] = []
      let queued = 0
      let skipped = 0
      const reviewedProjects = new Set<string>()
      for (const { sessionId, projectId } of visible) {
        if (projectId === null || !editable.has(projectId)) {
          notAllowed.push(sessionId)
          continue
        }
        // Without this skip, Review on a page of reviewed sessions would quietly redo each one.
        if (await hasReviewFrom(db, { userId, sessionId, analyzer: PROBLEMS_ANALYZER })) {
          skipped += 1
          continue
        }
        // Null means the review is already waiting or running: it will be done all the same.
        await queueReview(db, { sessionId, projectId, analyzer: PROBLEMS_ANALYZER, options: {} })
        queued += 1
        reviewedProjects.add(projectId)
      }
      // As Run now does, with no harness path of the caller's; a server with no learnings
      // harness would only fail the run, so it queues none.
      const fixRunsQueued =
        env.learningsHarness === undefined
          ? 0
          : (
              await Promise.all(
                [...reviewedProjects].map((projectId) =>
                  // Null means a run is already running for the project; it is left alone.
                  queueFixRun(db, { projectId, waitForReviews: true, harnessPath: null }),
                ),
              )
            ).filter((run) => run !== null).length
      if (queued > 0) notifyWorker()
      return c.json({ queued, skipped, notAllowed, fixRunsQueued }, 202)
    },
  )
