import { ingestPayloadSchema } from "@samskara/core"
import { Hono } from "hono"
import type { Db } from "../db/client.js"
import type { Env } from "../lib/env.js"
import { type AuthVariables, requireAuth } from "../lib/require-auth.js"
import { validate } from "../lib/validate.js"
import { ingest } from "../services/ingest.js"

type Deps = { readonly db: Db; readonly env: Env }

export const ingestRoutes = ({ db, env }: Deps) =>
  new Hono<{ Variables: AuthVariables }>().post(
    "/",
    requireAuth({ db, env }, ["cli"]),
    validate("json", ingestPayloadSchema),
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
      if ("error" in result && result.error === "sessionNotFound") {
        log?.warn("ingest rejected: no such session for this user")
        return context.json(result, 409)
      }
      if ("error" in result && result.error === "projectForbidden") {
        log?.warn(
          { projectId: payload.project.projectId },
          "ingest rejected: project not writable by this user",
        )
        return context.json(result, 403)
      }
      return context.json(result, 200)
    },
  )
