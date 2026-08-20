import { Hono } from "hono"
import { ZodError } from "zod"
import type { Db } from "../db/client.js"
import type { Env } from "../lib/env.js"
import { type AuthVariables, requireAuth } from "../lib/require-auth.js"
import { listForSession } from "../repositories/artifacts.repo.js"
import {
  AmbiguousCommitError,
  type SessionDetailRow,
  type SessionSummaryRow,
  findVisibleProjectBySlug,
  getDetail,
  listAccessible,
  remove,
} from "../repositories/sessions.repo.js"
import {
  type SessionListQuery,
  dateWindowFor,
  parseSessionListQuery,
} from "../search/sessionFilters.js"
import { SessionQueryError } from "../search/sessionQuery.js"
import { serializeArtifact } from "./artifacts.js"

type Deps = {
  readonly db: Db
  readonly env: Env
}

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
  ...(row.match === null ? {} : { match: row.match }),
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

  app.get("/", requireAuth({ db, env }, ["web"]), async (c) => {
    let query: SessionListQuery
    try {
      query = parseSessionListQuery(c.req.query())
    } catch (error) {
      if (error instanceof SessionQueryError) return c.json({ error: "invalidSearchQuery" }, 400)
      if (error instanceof ZodError) {
        const field = error.issues[0]?.path[0]
        const codes: Record<string, string> = {
          pr: "invalidPrNumber",
          commit: "invalidCommit",
          q: "invalidSearchQuery",
          repo: "invalidRepo",
          branch: "invalidBranch",
          tz: "invalidTimeZone",
          page: "invalidPage",
          limit: "invalidLimit",
          sort: "invalidSort",
          range: "invalidRange",
          project: "invalidProject",
          user: "invalidUser",
        }
        return c.json({ error: codes[String(field)] ?? "invalidFilter" }, 400)
      }
      throw error
    }
    const userId = c.get("user").id
    if (
      query.project !== undefined &&
      (await findVisibleProjectBySlug(db, userId, query.project)) === null
    ) {
      return c.json({ error: "projectNotFound" }, 404)
    }
    try {
      const result = await listAccessible(db, userId, {
        projectSlug: query.project,
        userLogin: query.user,
        repoId: query.repo,
        branch: query.branch,
        prNumber: query.pr,
        commit: query.commit,
        searchQuery: query.parsedQuery,
        ...dateWindowFor(query, new Date()),
        sort: query.sort,
        page: query.page,
        limit: query.limit,
      })
      const page = query.page ?? 1
      const limit = query.limit ?? 50
      return c.json({
        sessions: result.rows.map(serialize),
        pagination: {
          page,
          limit,
          total: result.total,
          totalPages: Math.ceil(result.total / limit),
        },
        filterOptions: result.filterOptions,
      })
    } catch (error) {
      if (error instanceof AmbiguousCommitError) return c.json({ error: "ambiguousCommit" }, 400)
      throw error
    }
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
