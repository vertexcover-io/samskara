import { zValidator } from "@hono/zod-validator"
import { ingestPayloadSchema } from "@samskara/core"
import { Hono } from "hono"
import type { Db } from "../db/client.js"
import type { Env } from "../lib/env.js"
import { type AuthVariables, requireAuth } from "../lib/require-auth.js"
import { ingest } from "../services/ingest.js"

type Deps = { readonly db: Db; readonly env: Env }

export const ingestRoutes = ({ db, env }: Deps): Hono<{ Variables: AuthVariables }> => {
  const app = new Hono<{ Variables: AuthVariables }>()

  app.post(
    "/",
    requireAuth({ db, env }, ["cli"]),
    zValidator("json", ingestPayloadSchema),
    async (context) => {
      const payload = context.req.valid("json")
      const log = context.get("log")
      log?.setBindings({
        sessionId: payload.sessionId,
        eventCount: payload.records.reduce((count, record) => count + record.messages.length, 0),
        repo: payload.project.slug,
        isSubagent: payload.type === "subagent",
      })
      const result = await ingest({ db, log, userId: context.get("user").id }, payload)
      if ("error" in result && result.error === "sessionNotFound") return context.json(result, 409)
      return context.json(result, 200)
    },
  )

  return app
}
