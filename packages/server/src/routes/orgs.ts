import { registerOrgRequestSchema, updateOrgRequestSchema } from "@samskara/core"
import { Hono } from "hono"
import type { Db } from "../db/client.js"
import type { Env } from "../lib/env.js"
import { type AuthVariables, requireAuth } from "../lib/require-auth.js"
import { validate } from "../lib/validate.js"
import {
  findBySlug,
  findDetailBySlug,
  isVisibleTo,
  listVisibleOrgs,
  registerBySlug,
  updateOrg,
} from "../repositories/orgs.repo.js"
import { isSuperAdmin } from "../repositories/users.repo.js"

type Deps = {
  readonly db: Db
  readonly env: Env
}

export const orgsRoutes = ({ db, env }: Deps) =>
  new Hono<{ Variables: AuthVariables }>()
    .get("/", requireAuth({ db, env }, ["web"]), async (c) => {
      const visibleOrgs = await listVisibleOrgs(db, c.get("user").id)
      return c.json({ orgs: visibleOrgs }, 200)
    })
    .post(
      "/",
      requireAuth({ db, env }, ["web"]),
      validate("json", registerOrgRequestSchema),
      async (c) => {
        if (!(await isSuperAdmin(db, c.get("user").id))) return c.json({ error: "forbidden" }, 403)
        const { githubSlug, autoAddMembers } = c.req.valid("json")
        const slug = githubSlug.toLowerCase()
        const { org, created } = await registerBySlug(db, slug, { autoAddMembers })
        return c.json({ org }, created ? 201 : 200)
      },
    )
    .get("/:slug", requireAuth({ db, env }, ["web"]), async (c) => {
      const detail = await findDetailBySlug(db, c.get("user").id, c.req.param("slug").toLowerCase())
      if (detail === null) return c.json({ error: "orgNotFound" }, 404)
      return c.json({ org: detail }, 200)
    })
    .patch(
      "/:slug",
      requireAuth({ db, env }, ["web"]),
      validate("json", updateOrgRequestSchema),
      async (c) => {
        const org = await findBySlug(db, c.req.param("slug").toLowerCase())
        if (org === null || !(await isVisibleTo(db, c.get("user").id, org.id))) {
          return c.json({ error: "orgNotFound" }, 404)
        }
        await updateOrg(db, org.id, c.req.valid("json"))
        const updated = await findDetailBySlug(db, c.get("user").id, org.githubSlug)
        return c.json({ org: updated }, 200)
      },
    )
