import { createProjectRequestSchema, reassignSessionsRequestSchema } from "@samskara/core"
import { Hono } from "hono"
import type { Db } from "../db/client.js"
import type { Env } from "../lib/env.js"
import { type AuthVariables, requireAuth } from "../lib/require-auth.js"
import { validate } from "../lib/validate.js"
import { listAccessibleSummaries, type ProjectSummaryRow } from "../repositories/projects.repo.js"
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
})

export const projectsRoutes = ({ db, env }: Deps) =>
  new Hono<{ Variables: AuthVariables }>()
    .get("/", requireAuth({ db, env }, ["web", "cli"]), async (c) => {
      const rows = await listAccessibleSummaries(db, c.get("user").id)
      return c.json({ projects: rows.map(serialize) }, 200)
    })
    // The CLI's `--project <name|slug>` needs a name-to-id lookup. `GET /` above is
    // web-audience-only by contract (a cli token never reads the web API), so this is the
    // cli-side counterpart: the same visibility, the bare fields resolution needs.
    .get("/resolve", requireAuth({ db, env }, ["cli"]), async (c) => {
      const rows = await listAccessibleSummaries(db, c.get("user").id)
      return c.json(
        { projects: rows.map((row) => ({ id: row.id, name: row.name, slug: row.slug })) },
        200,
      )
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
