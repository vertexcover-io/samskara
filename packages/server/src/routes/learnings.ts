import type { HarnessRunner } from "@samskara/core"
import { Hono } from "hono"
import { z } from "zod"
import type { Db } from "../db/client.js"
import type { Env } from "../lib/env.js"
import { type AuthVariables, requireAuth } from "../lib/require-auth.js"
import { validate } from "../lib/validate.js"
import * as learningsRepo from "../repositories/learnings.repo.js"
import { findBySlug, isVisibleTo } from "../repositories/orgs.repo.js"
import { startLearningRun } from "../services/learnings/run.js"

type Deps = {
  readonly db: Db
  readonly env: Env
  readonly runner: HarnessRunner
}

const uuid = z.string().uuid()

const serializeRun = (run: learningsRepo.LearningRunRow) => ({
  id: run.id,
  status: run.status,
  harnessRef: run.harnessRef,
  error: run.error,
  startedAt: run.startedAt.toISOString(),
  finishedAt: run.finishedAt?.toISOString() ?? null,
})

const serializeLearning = (row: learningsRepo.LearningRow) => ({
  id: row.id,
  title: row.title,
  cause: row.cause,
  problem: row.problem,
  priority: row.priority,
  priorityReason: row.priorityReason,
  fixType: row.fixType,
  fix: row.fix,
  updatedByRunId: row.updatedByRunId,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
})

/** A problem behind a learning: what it was, where it came from, and its evidence. */
const serializeProblem = (
  problem: Awaited<ReturnType<typeof learningsRepo.problemsOfLearning>>[number],
) => ({
  id: problem.id,
  sessionId: problem.sessionId,
  reviewId: problem.reviewId,
  projectId: problem.projectId,
  title: problem.title,
  class: problem.class,
  severity: problem.severity,
  severityReason: problem.severityReason,
  fixType: problem.fixType,
  description: problem.description,
  learning: problem.learning,
  evidence: problem.evidence,
})

/**
 * Learnings: problems from many sessions grouped by cause, each with what to change. A run
 * starts weekly on its own (see `startLearningSchedule`) or here, by hand. Everything is
 * scoped to an org, and only its members see it.
 */
export const learningsRoutes = ({ db, env, runner }: Deps) => {
  /** The org, when the caller may see it; null reads as 404 either way. */
  const visibleOrg = async (userId: string, slug: string) => {
    const org = await findBySlug(db, slug)
    if (org === null || !(await isVisibleTo(db, userId, org.id))) return null
    return org
  }

  return (
    new Hono<{ Variables: AuthVariables }>()
      /**
       * Start a run now. The harness path names a checkout on the server's machine; without
       * one, the server's own LEARNINGS_HARNESS_PATH is used. 202 with the run id, which the
       * caller polls.
       */
      .post(
        "/runs",
        requireAuth({ db, env }, ["web", "cli"]),
        validate(
          "json",
          z.object({ org: z.string().min(1), harnessPath: z.string().min(1).optional() }).strict(),
        ),
        async (c) => {
          const body = c.req.valid("json")
          const org = await visibleOrg(c.get("user").id, body.org)
          if (org === null) return c.json({ error: "orgNotFound" }, 404)
          const harnessPath = body.harnessPath ?? env.learningsHarnessPath
          if (harnessPath === undefined) return c.json({ error: "noHarnessPath" }, 400)
          const started = await startLearningRun({ db, runner, env, log: c.get("log") }, org.id, {
            harnessPath,
          })
          if (started.status === "busy") return c.json({ error: "learningRunAlreadyRunning" }, 409)
          return c.json({ runId: started.runId }, 202)
        },
      )
      .get("/runs/:id", requireAuth({ db, env }, ["web", "cli"]), async (c) => {
        const id = c.req.param("id")
        const run = uuid.safeParse(id).success ? await learningsRepo.getRun(db, id) : null
        if (run === null || !(await isVisibleTo(db, c.get("user").id, run.orgId)))
          return c.json({ error: "runNotFound" }, 404)
        return c.json({ run: serializeRun(run) }, 200)
      })
      /** The org's learnings, high priority first, with how many problems and sessions each has. */
      .get("/", requireAuth({ db, env }, ["web", "cli"]), async (c) => {
        const org = await visibleOrg(c.get("user").id, c.req.query("org") ?? "")
        if (org === null) return c.json({ error: "orgNotFound" }, 404)
        const [rows, latest] = await Promise.all([
          learningsRepo.listLearnings(db, org.id),
          learningsRepo.latestRun(db, org.id),
        ])
        return c.json(
          {
            learnings: rows.map((row) => ({
              ...serializeLearning(row),
              problemCount: row.problemCount,
              sessionCount: row.sessionCount,
            })),
            latestRun: latest === null ? null : serializeRun(latest),
          },
          200,
        )
      })
      /** One learning, with every problem behind it, so a reader can check it holds. */
      .get("/:id", requireAuth({ db, env }, ["web", "cli"]), async (c) => {
        const id = c.req.param("id")
        const row = uuid.safeParse(id).success ? await learningsRepo.getLearning(db, id) : null
        if (row === null || !(await isVisibleTo(db, c.get("user").id, row.orgId)))
          return c.json({ error: "learningNotFound" }, 404)
        const problems = await learningsRepo.problemsOfLearning(db, row.id)
        return c.json(
          { learning: serializeLearning(row), problems: problems.map(serializeProblem) },
          200,
        )
      })
  )
}
