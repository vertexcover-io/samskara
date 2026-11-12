import {
  type DecisionRequest,
  type Evidence,
  evidenceMessages,
  FIX_TYPES,
  type FixDecision,
  type LearningImpact,
  messageIdAt,
  parseStory,
  REJECT_REASON_MAX,
  recordsInReviewOrder,
  returnsAtSessions,
} from "@samskara/core"
import { Hono } from "hono"
import { z } from "zod"
import type { Db } from "../db/client.js"
import type { Env } from "../lib/env.js"
import { type AuthVariables, requireAuth } from "../lib/require-auth.js"
import { validate } from "../lib/validate.js"
import * as learningsRepo from "../repositories/learnings.repo.js"
import { authorityFor, canRead, type Scope } from "../repositories/projects.repo.js"
import { sessionMessages } from "../repositories/sessions.repo.js"
import { queueFixRun } from "../repositories/workQueue.repo.js"
import { reviewSessionExport } from "../services/ai-review/sessionExport.js"

type Deps = {
  readonly db: Db
  readonly env: Env
  /** Wakes the worker once the run is queued. */
  readonly notifyWorker: () => void
}

const uuid = z.string().uuid()

/** A decision as the API takes it: Reject needs a reason, one non-blank line. */
const decisionBody = z.discriminatedUnion("decision", [
  z.object({ decision: z.enum(["open", "accepted", "skipped"]) }).strict(),
  z
    .object({
      decision: z.literal("rejected"),
      reason: z
        .string()
        .trim()
        .min(1)
        .max(REJECT_REASON_MAX)
        .regex(/^[^\r\n]*$/, "one line"),
    })
    .strict(),
]) satisfies z.ZodType<DecisionRequest>

const serializeRun = (run: learningsRepo.LearningRunRow) => ({
  id: run.id,
  projectId: run.projectId,
  status: run.status,
  harnessRef: run.harnessRef,
  error: run.error,
  startedAt: run.startedAt.toISOString(),
  finishedAt: run.finishedAt?.toISOString() ?? null,
})

const serializeLearning = (row: learningsRepo.LearningRow) => ({
  id: row.id,
  projectId: row.projectId,
  title: row.title,
  cause: row.cause,
  problem: row.problem,
  priority: row.priority,
  priorityReason: row.priorityReason,
  fixType: row.fixType,
  fix: row.fix,
  impact: row.impact as LearningImpact | null,
  impactReason: row.impactReason,
  howItHelps: row.howItHelps,
  fixSummary: row.fixSummary,
  story: parseStory(row.story),
  decision: row.decision as FixDecision,
  decidedAt: row.decidedAt?.toISOString() ?? null,
  rejectReason: row.rejectReason,
  skipCount: row.skipCount,
  sessionsAtSkip: row.sessionsAtSkip,
  // The session count at which a skipped fix comes back; null when it is not skipped.
  returnsAtSessions: returnsAtSessions(row as Parameters<typeof returnsAtSessions>[0]),
  // `samskara learn` (packages/cli/src/commands/learn.ts) lists only fixes whose skippedAt is
  // null, in this repo and in every CLI already installed; a rejected fix must stay off it too.
  skippedAt:
    row.decision === "skipped" || row.decision === "rejected"
      ? (row.decidedAt?.toISOString() ?? null)
      : null,
  updatedByRunId: row.updatedByRunId,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
})

/** Where a problem's review came from: its session's title, and the order it numbered msg-N by. */
type ReviewSource = {
  readonly title: string | null
  readonly recordIds: ReadonlyArray<string | null> | null
}

/**
 * A problem behind a learning: what it was, where it came from, and its evidence, each item
 * with the real id of the message it starts at, or null when that cannot be found.
 */
const serializeProblem = (
  problem: Awaited<ReturnType<typeof learningsRepo.problemsOfLearning>>[number],
  source: ReviewSource | undefined,
) => ({
  id: problem.id,
  sessionId: problem.sessionId,
  sessionTitle: source?.title ?? null,
  reviewId: problem.reviewId,
  projectId: problem.projectId,
  title: problem.title,
  class: problem.class,
  severity: problem.severity,
  severityReason: problem.severityReason,
  fixType: problem.fixType,
  description: problem.description,
  learning: problem.learning,
  evidence: (problem.evidence as ReadonlyArray<Evidence>).map((item) => ({
    ...item,
    messageId: messageIdAt(source?.recordIds ?? null, item.from),
  })),
})

/**
 * Learnings: problems from many sessions grouped by cause, each with what to change. A run is
 * queued for the worker every few days on its own (`queueDueFixRuns`) or here, by hand. Everything is
 * scoped to a project: whoever may read the project sees its learnings, and an editor may
 * start a run.
 */
export const learningsRoutes = ({ db, env, notifyWorker }: Deps) => {
  /** What the caller may do in the project, or null when they cannot see it (a 404). */
  const scopeIn = async (userId: string, projectId: string): Promise<Scope | null> =>
    uuid.safeParse(projectId).success ? authorityFor(db, userId, projectId) : null

  return (
    new Hono<{ Variables: AuthVariables }>()
      /**
       * Start a run now; an editor of the project may. The harness path names a checkout on
       * the server's machine, so only a project admin may pass one — anyone else gets the
       * server's own harness (LEARNINGS_HARNESS_REPO or LEARNINGS_HARNESS_PATH). 202 with the
       * run id, which the caller polls. The run is queued for the worker and, by default, waits
       * until the project has no review waiting or running; a run already waiting is reused.
       */
      .post(
        "/runs",
        requireAuth({ db, env }, ["web", "cli"]),
        validate(
          "json",
          z
            .object({
              project: uuid,
              harnessPath: z.string().min(1).optional(),
              /** False starts it even while the project's reviews run; the popup's "Run anyway". */
              waitForReviews: z.boolean().optional(),
            })
            .strict(),
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
          const queued = await queueFixRun(db, {
            projectId: body.project,
            waitForReviews: body.waitForReviews ?? true,
            harnessPath: body.harnessPath ?? null,
          })
          if (queued === null) {
            // The run it collided with, so the caller can point at it instead of only refusing.
            const open = await learningsRepo.openRun(db, body.project)
            return c.json({ error: "learningRunAlreadyRunning", runId: open?.id ?? null }, 409)
          }
          notifyWorker()
          return c.json({ runId: queued.id }, 202)
        },
      )
      /**
       * The project's runs, newest first, with how many fixes each created and updated, and how
       * many of its reviews are waiting or running, so Run now can ask before running over them.
       */
      .get("/runs", requireAuth({ db, env }, ["web", "cli"]), async (c) => {
        const projectId = c.req.query("project") ?? ""
        const scope = await scopeIn(c.get("user").id, projectId)
        if (scope === null) return c.json({ error: "projectNotFound" }, 404)
        const [runs, reviewsWaiting] = await Promise.all([
          learningsRepo.listRuns(db, projectId),
          learningsRepo.reviewsWaiting(db, projectId),
        ])
        return c.json(
          {
            runs: runs.map((run) => ({
              ...serializeRun(run),
              fixesCreated: run.fixesCreated,
              fixesUpdated: run.fixesUpdated,
            })),
            reviewsWaiting,
            canEdit: scope !== "viewer",
          },
          200,
        )
      })
      .get("/runs/:id", requireAuth({ db, env }, ["web", "cli"]), async (c) => {
        const id = c.req.param("id")
        const run = uuid.safeParse(id).success ? await learningsRepo.getRun(db, id) : null
        if (run === null || !(await canRead(db, c.get("user").id, run.projectId)))
          return c.json({ error: "runNotFound" }, 404)
        return c.json({ run: serializeRun(run) }, 200)
      })
      /**
       * The project's learnings, high priority first, with how many problems and sessions each
       * has and when they were seen. `type` keeps one fix type; `from` and `to` (instants, `to`
       * exclusive) keep learnings with a problem that happened between them.
       */
      .get(
        "/",
        requireAuth({ db, env }, ["web", "cli"]),
        validate(
          "query",
          z.object({
            project: z.string().optional(),
            type: z.enum(FIX_TYPES).optional(),
            from: z.string().datetime({ offset: true }).optional(),
            to: z.string().datetime({ offset: true }).optional(),
            run: uuid.optional(),
          }),
        ),
        async (c) => {
          const query = c.req.valid("query")
          const projectId = query.project ?? ""
          const scope = await scopeIn(c.get("user").id, projectId)
          if (scope === null) return c.json({ error: "projectNotFound" }, 404)
          const [rows, latest] = await Promise.all([
            learningsRepo.listLearnings(db, projectId, {
              fixType: query.type,
              seenFrom: query.from === undefined ? undefined : new Date(query.from),
              seenBefore: query.to === undefined ? undefined : new Date(query.to),
              runId: query.run,
            }),
            learningsRepo.latestRun(db, projectId),
          ])
          return c.json(
            {
              learnings: rows.map((row) => ({
                ...serializeLearning(row),
                problemCount: row.problemCount,
                sessionCount: row.sessionCount,
                firstSeenAt: row.firstSeenAt?.toISOString() ?? null,
                lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
                sessionsLast7Days: row.sessionsLast7Days,
                runMark: row.runMark,
              })),
              latestRun: latest === null ? null : serializeRun(latest),
              canEdit: scope !== "viewer",
            },
            200,
          )
        },
      )
      /** One learning, with every problem behind it, so a reader can check it holds. */
      .get("/:id", requireAuth({ db, env }, ["web", "cli"]), async (c) => {
        const id = c.req.param("id")
        const row = uuid.safeParse(id).success ? await learningsRepo.getLearning(db, id) : null
        const scope = row === null ? null : await authorityFor(db, c.get("user").id, row.projectId)
        if (row === null || scope === null) return c.json({ error: "learningNotFound" }, 404)
        const problems = await learningsRepo.problemsOfLearning(db, row.id)
        const reviews = await learningsRepo.reviewSessions(db, [
          ...new Set(problems.map((problem) => problem.reviewId)),
        ])
        // A session since moved to another project is that project's to show, title and all.
        const sources = new Map(
          reviews
            .filter((review) => review.projectId === row.projectId)
            .map((review) => [review.reviewId, review]),
        )
        return c.json(
          {
            learning: serializeLearning(row),
            problems: problems.map((problem) =>
              serializeProblem(problem, sources.get(problem.reviewId)),
            ),
            canEdit: scope !== "viewer",
          },
          200,
        )
      })
      /**
       * The messages behind one quote: the ones it cites and a couple on each side, so a reader
       * can check the quote on the fix page itself. Read on demand, because a session can hold
       * thousands of messages and a fix cites many sessions.
       */
      .get(
        "/:id/messages",
        requireAuth({ db, env }, ["web", "cli"]),
        validate("query", z.object({ problem: uuid, quote: z.coerce.number().int().min(0) })),
        async (c) => {
          const id = c.req.param("id")
          const { problem: problemId, quote } = c.req.valid("query")
          const notFound = () => c.json({ error: "messagesNotFound" }, 404)
          const row = uuid.safeParse(id).success ? await learningsRepo.getLearning(db, id) : null
          if (row === null || !(await canRead(db, c.get("user").id, row.projectId)))
            return notFound()
          const problem = (await learningsRepo.problemsOfLearning(db, row.id)).find(
            (p) => p.id === problemId,
          )
          const item = (problem?.evidence as ReadonlyArray<Evidence> | undefined)?.[quote]
          if (problem === undefined || item === undefined) return notFound()
          const [review] = await learningsRepo.reviewSessions(db, [problem.reviewId])
          // A session since moved to another project is that project's to show.
          if (
            review === undefined ||
            review.recordIds === null ||
            review.projectId !== row.projectId
          )
            return notFound()
          const records = recordsInReviewOrder(
            reviewSessionExport({
              session: { id: review.sessionId, title: review.title, source: review.source },
              messages: await sessionMessages(db, review.sessionId),
            }).records,
            review.recordIds,
          )
          return c.json({ messages: evidenceMessages(records, item) }, 200)
        },
      )
      /** Set a fix's decision: accept, skip, reject with a reason, or reopen. An editor may. */
      .post(
        "/:id/decision",
        requireAuth({ db, env }, ["web", "cli"]),
        validate("json", decisionBody),
        async (c) => {
          const id = c.req.param("id")
          const userId = c.get("user").id
          const row = uuid.safeParse(id).success ? await learningsRepo.getLearning(db, id) : null
          const scope = row === null ? null : await authorityFor(db, userId, row.projectId)
          if (row === null || scope === null) return c.json({ error: "learningNotFound" }, 404)
          if (scope === "viewer") return c.json({ error: "notEditable" }, 403)
          const updated = await learningsRepo.setDecision(db, row.id, c.req.valid("json"), userId)
          if (updated === null) return c.json({ error: "learningNotFound" }, 404)
          return c.json({ learning: serializeLearning(updated) }, 200)
        },
      )
  )
}
