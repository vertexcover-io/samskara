import { createProjectRequestSchema, reassignSessionsRequestSchema } from "@samskara/core"
import { Hono } from "hono"
import type { Db } from "../db/client.js"
import type { Env } from "../lib/env.js"
import { type AuthVariables, requireAuth } from "../lib/require-auth.js"
import { validate } from "../lib/validate.js"
import {
  canDelete,
  findVisibleSummaryById,
  listAccessibleSummaries,
  type ProjectSummaryRow,
  remove,
} from "../repositories/projects.repo.js"
import { findOrCreateProject, reassignSessions } from "../services/projects.js"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Deps = {
  readonly db: Db
  readonly env: Env
}

const serialize = (row: ProjectSummaryRow) => ({
  id: row.id,
  name: row.name,
  slug: row.slug,
  owner: { type: row.ownerType, slug: row.ownerSlug },
  sessionCount: row.sessionCount,
  lastActiveAt: row.lastActiveAt === null ? null : new Date(row.lastActiveAt).toISOString(),
  repo:
    row.repoHost !== null && row.repoOwner !== null && row.repoName !== null
      ? { host: row.repoHost, owner: row.repoOwner, repoName: row.repoName }
      : null,
})

export const projectsRoutes = ({ db, env }: Deps) =>
  new Hono<{ Variables: AuthVariables }>()
    .get("/", requireAuth({ db, env }, ["web", "cli"]), async (c) => {
      const rows = await listAccessibleSummaries(db, c.get("user").id)
      return c.json({ projects: rows.map(serialize) }, 200)
    })
    .get("/:id", requireAuth({ db, env }, ["web"]), async (c) => {
      const projectId = c.req.param("id")
      if (!UUID.test(projectId)) return c.json({ error: "projectNotFound" }, 404)
      const userId = c.get("user").id
      const [row, deletable] = await Promise.all([
        findVisibleSummaryById(db, userId, projectId),
        canDelete(db, userId, projectId),
      ])
      if (row === null) return c.json({ error: "projectNotFound" }, 404)
      return c.json({ project: serialize(row), viewerCanDelete: deletable }, 200)
    })
    .delete("/:id", requireAuth({ db, env }, ["web"]), async (c) => {
      const projectId = c.req.param("id")
      const userId = c.get("user").id
      if (!UUID.test(projectId) || (await findVisibleSummaryById(db, userId, projectId)) === null) {
        return c.json({ error: "projectNotFound" }, 404)
      }
      if (!(await canDelete(db, userId, projectId))) return c.json({ error: "forbidden" }, 403)
      await remove(db, projectId)
      return c.body(null, 204)
    })
    .post(
      "/",
      requireAuth({ db, env }, ["cli"]),
      validate("json", createProjectRequestSchema),
      async (c) => {
        const user = c.get("user")
        const result = await findOrCreateProject(db, user.id, c.req.valid("json"))
        const owner =
          result.owner.type === "org"
            ? result.owner
            : { type: "user" as const, slug: user.githubLogin }
        const body = {
          id: result.id,
          owner,
          ...(result.reason === undefined ? {} : { reason: result.reason }),
        }
        return c.json(body, result.created ? 201 : 200)
      },
    )
    .post(
      "/:id/sessions",
      requireAuth({ db, env }, ["web", "cli"]),
      validate("json", reassignSessionsRequestSchema),
      async (c) => {
        const toProjectId = c.req.param("id")
        // The body is schema-checked but a path param is not, and `projects.id` is a uuid column:
        // handing Postgres a malformed one raises 22P02, which surfaces as a 500. Refused the same
        // way as a destination that cannot be written, so a typo cannot tell the two apart either.
        if (!UUID.test(toProjectId)) return c.json({ error: "destinationForbidden" } as const, 403)
        const result = await reassignSessions(
          db,
          c.get("user").id,
          toProjectId,
          c.req.valid("json"),
        )
        if ("error" in result) {
          c.get("log")?.warn({ toProjectId, error: result.error }, "reassign rejected")
          return c.json(result, 403)
        }
        return c.json(result, 200)
      },
    )
