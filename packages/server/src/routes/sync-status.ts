import { Hono } from "hono"
import type { Db } from "../db/client.js"
import type { Env } from "../lib/env.js"
import { type AuthVariables, requireAuth } from "../lib/require-auth.js"
import { listSyncStatus, type SyncStatusRow } from "../repositories/syncStatus.repo.js"

type Deps = {
  readonly db: Db
  readonly env: Env
}

const serialize = (row: SyncStatusRow) => ({
  userId: row.userId,
  githubLogin: row.githubLogin,
  name: row.name,
  avatarUrl: row.avatarUrl,
  projectId: row.projectId,
  projectName: row.projectName,
  projectSlug: row.projectSlug,
  sessionCount: row.sessionCount,
  lastSyncedAt: row.lastSyncedAt === null ? null : new Date(row.lastSyncedAt).toISOString(),
})

export const syncStatusRoutes = ({ db, env }: Deps) =>
  new Hono<{ Variables: AuthVariables }>().get(
    "/",
    requireAuth({ db, env }, ["web"]),
    async (c) => {
      const rows = await listSyncStatus(db, c.get("user").id)
      return c.json({ rows: rows.map(serialize) }, 200)
    },
  )
