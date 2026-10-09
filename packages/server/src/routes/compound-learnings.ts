import {
  learnOutcomeSchema,
  learnStatusSchema,
  learnTriggerSchema,
  pushCompoundLearningsRequestSchema,
} from "@samskara/core"
import { Hono } from "hono"
import { z } from "zod"
import type { Db } from "../db/client.js"
import type { Env } from "../lib/env.js"
import { type AuthVariables, requireAuth } from "../lib/require-auth.js"
import { validate } from "../lib/validate.js"
import {
  findCompoundLearning,
  listCompoundLearnings,
  recordEvents,
} from "../repositories/compoundLearnings.repo.js"

type Deps = { readonly db: Db; readonly env: Env }

const listQuerySchema = z
  .object({
    outcome: learnOutcomeSchema.optional(),
    status: learnStatusSchema.optional(),
    trigger: learnTriggerSchema.optional(),
    skillVersion: z.string().trim().min(1).max(100).optional(),
  })
  .strict()

type ListRow = Awaited<ReturnType<typeof listCompoundLearnings>>[number]

const serialize = ({ event, userLogin, projectId, projectName }: ListRow) => {
  const { userId: _userId, createdAt: _createdAt, occurredAt, optionsShown, ...rest } = event
  return {
    ...rest,
    occurredAt: occurredAt.toISOString(),
    optionsShown: optionsShown ?? [],
    userLogin,
    projectId,
    projectName,
  }
}

export const compoundLearningsRoutes = ({ db, env }: Deps) =>
  new Hono<{ Variables: AuthVariables }>()
    .post(
      "/",
      requireAuth({ db, env }, ["cli"]),
      validate("json", pushCompoundLearningsRequestSchema),
      async (c) => {
        const { events } = c.req.valid("json")
        const result = await recordEvents(db, c.get("user").id, events)
        c.get("log")?.info({ received: events.length, ...result }, "compound learnings recorded")
        return c.json(result, 200)
      },
    )
    .get(
      "/",
      requireAuth({ db, env }, ["web", "cli"]),
      validate("query", listQuerySchema),
      async (c) => {
        const rows = await listCompoundLearnings(db, c.get("user").id, c.req.valid("query"))
        return c.json({ events: rows.map(serialize) }, 200)
      },
    )
    .get(
      "/:id",
      requireAuth({ db, env }, ["web", "cli"]),
      validate("param", z.object({ id: z.uuid() })),
      async (c) => {
        const found = await findCompoundLearning(db, c.get("user").id, c.req.valid("param").id)
        if (found === null) return c.json({ error: "notFound" }, 404)
        return c.json(
          {
            event: serialize(found),
            evidenceRange: found.evidenceRange,
            evidence: found.evidence,
            truncated: found.truncated,
          },
          200,
        )
      },
    )
