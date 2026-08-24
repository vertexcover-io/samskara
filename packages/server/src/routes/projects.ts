import { zValidator } from "@hono/zod-validator"
import { createProjectRequestSchema } from "@samskara/core"
import { Hono } from "hono"
import type { Db } from "../db/client.js"
import type { Env } from "../lib/env.js"
import { type AuthVariables, requireAuth } from "../lib/require-auth.js"
import { type ProjectSummaryRow, listAccessibleSummaries } from "../repositories/projects.repo.js"
import { findOrCreateProject } from "../services/projects.js"

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

export const projectsRoutes = ({ db, env }: Deps): Hono<{ Variables: AuthVariables }> => {
  const app = new Hono<{ Variables: AuthVariables }>()

  app.get("/", requireAuth({ db, env }, ["web"]), async (c) => {
    const rows = await listAccessibleSummaries(db, c.get("user").id)
    return c.json({ projects: rows.map(serialize) })
  })

  app.post(
    "/",
    requireAuth({ db, env }, ["cli"]),
    zValidator("json", createProjectRequestSchema),
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

  return app
}
