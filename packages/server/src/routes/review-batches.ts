import { zValidator } from "@hono/zod-validator"
import { Hono } from "hono"
import { z } from "zod"
import type { Db } from "../db/client.js"
import { type Env, hasCredential } from "../lib/env.js"
import { type AuthVariables, requireAuth } from "../lib/require-auth.js"
import { canWrite } from "../repositories/projects.repo.js"
import {
  hasNewMessagesSince,
  latestDoneRun,
  visibleSessionProjectId,
} from "../repositories/reviews.repo.js"
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
  .object({
    sessionIds: z.array(z.string().min(1)).min(1).max(MAX_REVIEW_BATCH_SESSIONS),
    /** One mode for every ticked session; `newMessages` gives never-reviewed ones a full review. */
    mode: z.enum(["full", "newMessages"]).default("newMessages"),
  })
  .strict()

/**
 * Review ticked sessions in one mode: each one the caller may edit gets a run queued for the
 * worker (`full`, or in `newMessages` a full run when never reviewed, a new-part run when it
 * has new messages, and nothing when it has none), and each project that got a review queued gets a fix run that waits for its
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
      const { sessionIds: ids, mode } = c.req.valid("json")
      const sessionIds = [...new Set(ids)]
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
        // newMessages: a reviewed session continues from its newest run, and one with nothing new
        // is skipped, so a page of reviewed sessions is not quietly redone.
        const base =
          mode === "newMessages" ? await latestDoneRun(db, sessionId, PROBLEMS_ANALYZER) : null
        if (base !== null && !(await hasNewMessagesSince(db, sessionId, base.id))) {
          skipped += 1
          continue
        }
        const queuedRun = await queueReview(db, {
          sessionId,
          projectId,
          analyzer: PROBLEMS_ANALYZER,
          options: {},
          ...(base === null ? {} : { basedOn: base.id }),
        })
        // Null: a run is already waiting or running, and it will finish all the same.
        if (queuedRun === null) {
          skipped += 1
          continue
        }
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
