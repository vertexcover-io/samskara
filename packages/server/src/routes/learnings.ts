import type { HarnessRunner } from "@samskara/core"
import { Hono } from "hono"
import { z } from "zod"
import type { Db } from "../db/client.js"
import type { Env } from "../lib/env.js"
import { type AuthVariables, requireAuth } from "../lib/require-auth.js"
import { validate } from "../lib/validate.js"
import * as learningsRepo from "../repositories/learnings.repo.js"
import { authorityFor, canRead } from "../repositories/projects.repo.js"
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
 * scoped to a project: whoever may read the project sees its learnings, and an editor may
 * start a run.
 */
export const learningsRoutes = ({ db, env, runner }: Deps) => {
  /** Whether the caller may read the project; a project they cannot see reads as 404. */
  const readable = async (userId: string, projectId: string): Promise<boolean> =>
    uuid.safeParse(projectId).success && (await canRead(db, userId, projectId))

  return (
    new Hono<{ Variables: AuthVariables }>()
      /**
       * Start a run now; an editor of the project may. The harness path names a checkout on
       * the server's machine, so only a project admin may pass one — anyone else gets the
       * server's own harness (LEARNINGS_HARNESS_REPO or LEARNINGS_HARNESS_PATH). 202 with the
       * run id, which the caller polls.
       */
      .post(
        "/runs",
        requireAuth({ db, env }, ["web", "cli"]),
        validate(
          "json",
          z.object({ project: uuid, harnessPath: z.string().min(1).optional() }).strict(),
        ),
        async (c) => {
          const body = c.req.valid("json")
          const scope = await authorityFor(db, c.get("user").id, body.project)
          if (scope === null) return c.json({ error: "projectNotFound" }, 404)
          if (scope === "viewer") return c.json({ error: "notEditable" }, 403)
          if (body.harnessPath !== undefined && scope !== "admin")
            return c.json({ error: "harnessPathNeedsAdmin" }, 403)
          const harness =
            body.harnessPath === undefined ? env.learningsHarness : { path: body.harnessPath }
          if (harness === undefined) return c.json({ error: "noHarnessPath" }, 400)
          const started = await startLearningRun(
            { db, runner, env, log: c.get("log") },
            body.project,
            { harness },
          )
          if (started.status === "busy") return c.json({ error: "learningRunAlreadyRunning" }, 409)
          return c.json({ runId: started.runId }, 202)
        },
      )
      .get("/runs/:id", requireAuth({ db, env }, ["web", "cli"]), async (c) => {
        const id = c.req.param("id")
        const run = uuid.safeParse(id).success ? await learningsRepo.getRun(db, id) : null
        if (run === null || !(await canRead(db, c.get("user").id, run.projectId)))
          return c.json({ error: "runNotFound" }, 404)
        return c.json({ run: serializeRun(run) }, 200)
      })
      /** The project's learnings, high priority first, with how many problems and sessions each has. */
      .get("/", requireAuth({ db, env }, ["web", "cli"]), async (c) => {
        const projectId = c.req.query("project") ?? ""
        if (!(await readable(c.get("user").id, projectId)))
          return c.json({ error: "projectNotFound" }, 404)
        const [rows, latest] = await Promise.all([
          learningsRepo.listLearnings(db, projectId),
          learningsRepo.latestRun(db, projectId),
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
        if (row === null || !(await canRead(db, c.get("user").id, row.projectId)))
          return c.json({ error: "learningNotFound" }, 404)
        const problems = await learningsRepo.problemsOfLearning(db, row.id)
        return c.json(
          { learning: serializeLearning(row), problems: problems.map(serializeProblem) },
          200,
        )
      })
  )
}
