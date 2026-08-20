import { zValidator } from "@hono/zod-validator"
import { Hono } from "hono"
import { z } from "zod"
import type { Db } from "../db/client.js"
import type { Env } from "../lib/env.js"
import { type AuthVariables, requireAuth } from "../lib/require-auth.js"
import { listForSession } from "../repositories/artifacts.repo.js"
import {
  type SessionDetailRow,
  type SessionSummaryRow,
  findVisibleProjectBySlug,
  getDetail,
  listAccessible,
  remove,
} from "../repositories/sessions.repo.js"
import { serializeArtifact } from "./artifacts.js"

type Deps = {
  readonly db: Db
  readonly env: Env
}

const RANGES = ["all", "hour", "today", "week", "month", "custom"] as const

const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional()

// websearch_to_tsquery honours `or`, so an unbounded keyword lets a request build a query that
// matches nearly every session and scores each one before the row limit applies.
const MAX_KEYWORD_LENGTH = 200

const querySchema = z.object({
  project: z.string().trim().min(1).optional(),
  user: z.string().trim().min(1).optional(),
  range: z.enum(RANGES).optional(),
  from: isoDate,
  to: isoDate,
  q: z.string().max(MAX_KEYWORD_LENGTH).optional(),
})

const SEARCH_LIMIT = 50

export const normalizeKeyword = (raw: string | undefined): string | undefined => {
  const text = raw?.trim() ?? ""
  return text.length < 2 ? undefined : text
}

const DAY_MS = 24 * 60 * 60 * 1000

const startOfUtcDay = (now: Date): Date =>
  new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))

type RangeQuery = {
  readonly range?: (typeof RANGES)[number]
  readonly from?: string
  readonly to?: string
}

const sinceFor = ({ range, from }: RangeQuery, now: Date): Date | undefined => {
  if (range === "custom") return from === undefined ? undefined : new Date(`${from}T00:00:00.000Z`)
  if (range === "hour") return new Date(now.getTime() - 60 * 60 * 1000)
  if (range === "today") return startOfUtcDay(now)
  if (range === "week") return new Date(now.getTime() - 7 * DAY_MS)
  if (range === "month") return new Date(now.getTime() - 30 * DAY_MS)
  return undefined
}

const untilFor = ({ range, to }: RangeQuery): Date | undefined =>
  range === "custom" && to !== undefined ? new Date(`${to}T23:59:59.999Z`) : undefined

const serialize = (row: SessionSummaryRow) => ({
  id: row.id,
  title: row.title,
  projectName: row.projectName,
  projectSlug: row.projectSlug,
  userLogin: row.userLogin,
  repo: row.repo,
  durationMs: row.durationMs === null ? null : Number(row.durationMs),
  tokensTotal: Number(row.tokensTotal),
  status: row.status,
  lastActiveAt: new Date(row.lastActiveAt).toISOString(),
  snippet: row.snippet,
})

const isoOrNull = (value: string | null): string | null =>
  value === null ? null : new Date(value).toISOString()

const serializeDetail = (detail: SessionDetailRow) => ({
  session: {
    ...detail.session,
    durationMs: detail.session.durationMs === null ? null : Number(detail.session.durationMs),
    lastActiveAt: new Date(detail.session.lastActiveAt).toISOString(),
  },
  messages: detail.messages.map((message) => ({
    ...message,
    timestamp: isoOrNull(message.timestamp),
  })),
  toolCalls: detail.toolCalls,
  subagents: detail.subagents,
  tokenUsage: detail.tokenUsage,
  commits: detail.commits.map((commit) => ({
    ...commit,
    recordedAt: new Date(commit.recordedAt).toISOString(),
  })),
  pullRequests: detail.pullRequests.map((pr) => ({
    ...pr,
    recordedAt: new Date(pr.recordedAt).toISOString(),
  })),
})

export const sessionsRoutes = ({ db, env }: Deps): Hono<{ Variables: AuthVariables }> => {
  const app = new Hono<{ Variables: AuthVariables }>()

  app.get("/", requireAuth({ db, env }, ["web"]), zValidator("query", querySchema), async (c) => {
    const { project, user, range, from, to, q } = c.req.valid("query")
    const userId = c.get("user").id

    if (project !== undefined && (await findVisibleProjectBySlug(db, userId, project)) === null) {
      return c.json({ error: "projectNotFound" }, 404)
    }

    const window = { range, from, to }
    const keyword = normalizeKeyword(q)
    const rows = await listAccessible(db, userId, {
      projectSlug: project,
      userLogin: user,
      since: sinceFor(window, new Date()),
      until: untilFor(window),
      q: keyword,
      limit: keyword === undefined ? undefined : SEARCH_LIMIT,
    })
    const hasMore = keyword !== undefined && rows.length > SEARCH_LIMIT
    const page = hasMore ? rows.slice(0, SEARCH_LIMIT) : rows

    return c.json({ sessions: page.map(serialize), hasMore })
  })

  app.get("/:id", requireAuth({ db, env }, ["web"]), async (c) => {
    const detail = await getDetail(db, c.get("user").id, c.req.param("id"))

    if (detail === null) return c.json({ error: "sessionNotFound" }, 404)

    return c.json(serializeDetail(detail))
  })

  app.get("/:id/artifacts", requireAuth({ db, env }, ["web"]), async (c) => {
    const rows = await listForSession(db, c.get("user").id, c.req.param("id"))

    if (rows === null) return c.json({ error: "sessionNotFound" }, 404)

    return c.json({ artifacts: rows.map(serializeArtifact) })
  })

  /**
   * Scoped to `cli` rather than `web`: this exists so a local replay can re-ingest a session from
   * its transcript, and nothing in the web app should be able to destroy captured history.
   */
  app.delete("/:id", requireAuth({ db, env }, ["cli"]), async (c) => {
    const removed = await remove(db, c.req.param("id"), c.get("user").id)

    if (!removed) return c.json({ error: "sessionNotFound" }, 404)

    return c.body(null, 204)
  })

  return app
}
