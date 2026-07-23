import { zValidator } from "@hono/zod-validator"
import { MSG_TYPES } from "@samskara/core"
import type { IngestPayload } from "@samskara/core"
import { Hono } from "hono"
import { z } from "zod"
import type { Db } from "../db/client.js"
import type { Env } from "../lib/env.js"
import { type AuthVariables, requireAuth } from "../lib/require-auth.js"
import { ingest } from "../services/ingest.js"

type Deps = {
  readonly db: Db
  readonly env: Env
}

const zProject = z.object({
  name: z.string(),
  slug: z.string(),
})

const zTokens = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  cached: z.number().int().nonnegative(),
  thinking: z.number().int().nonnegative(),
})

const zMessage = z.object({
  lineUuid: z.string(),
  subIndex: z.number().int().nonnegative(),
  sessionId: z.string(),
  source: z.string(),
  sourceSchemaVersion: z.number().int(),
  msgType: z.enum(MSG_TYPES),
  timestamp: z.string(),
  lineNumber: z.number().int().positive(),
  content: z.string().optional(),
  thinking: z.string().optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  role: z.string().optional(),
  parentUuid: z.string().optional(),
  tokens: zTokens.optional(),
  toolCall: z.object({ id: z.string(), name: z.string(), input: z.unknown() }).optional(),
  toolResult: z
    .object({ callId: z.string(), output: z.string(), status: z.enum(["success", "failure"]) })
    .optional(),
  agentId: z.string().optional(),
  gitBranch: z.string().optional(),
  gitCommit: z.string().optional(),
})

const zBase = {
  sessionId: z.string(),
  sourceRelativePath: z.string(),
  project: zProject,
  rawLines: z.array(z.object({ lineUuid: z.string(), raw: z.string() })),
  messages: z.array(zMessage),
}

const zSession = z.object({
  model: z.string().optional(),
  title: z.string().optional(),
  cwd: z.string().optional(),
  cliVersion: z.string().optional(),
  permissionMode: z.string().optional(),
})

const zAgent = z.object({
  agentId: z.string(),
  agentType: z.string().optional(),
  description: z.string().optional(),
  spawnDepth: z.number().int().optional(),
  spawnToolUseId: z.string().optional(),
})

const zIngest = z.discriminatedUnion("type", [
  z.object({ ...zBase, type: z.literal("main"), session: zSession }),
  z.object({ ...zBase, type: z.literal("subagent"), agent: zAgent }),
])

type Parsed = z.infer<typeof zIngest>
const _contract = (payload: Parsed): IngestPayload => payload

export const ingestRoutes = ({ db, env }: Deps): Hono<{ Variables: AuthVariables }> => {
  const app = new Hono<{ Variables: AuthVariables }>()

  app.post("/", requireAuth({ db, env }, "cli"), zValidator("json", zIngest), async (c) => {
    const payload = c.req.valid("json")
    const log = c.get("log")
    log?.setBindings({
      sessionId: payload.sessionId,
      eventCount: payload.messages.length,
      repo: payload.project.slug,
      isSubagent: payload.type === "subagent",
    })
    const result = await ingest({ db, log, userId: c.get("user").id }, payload)
    if ("error" in result && result.error === "sessionNotFound") return c.json(result, 409)
    return c.json(result, 200)
  })

  return app
}
