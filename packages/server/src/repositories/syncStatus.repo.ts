import { and, asc, eq, isNotNull, or, sql } from "drizzle-orm"
import type { Db } from "../db/client.js"
import { projects, users } from "../db/schema.js"
import { memberOfProject, visibleToUser } from "./projects.repo.js"

export type SyncStatusRow = {
  readonly userId: string
  readonly githubLogin: string
  readonly name: string | null
  readonly avatarUrl: string | null
  readonly projectId: string | null
  readonly projectName: string | null
  readonly projectSlug: string | null
  readonly sessionCount: number
  readonly lastSyncedAt: string | null
}

const pairSessions = sql`"sessions" where "sessions"."projectId" = "projects"."id" and "sessions"."userId" = "users"."id"`

const sessionCount = sql<number>`(select count(*)::int from ${pairSessions})`

const lastSyncedAt = sql<string | null>`(select max("sessions"."updatedAt") from ${pairSessions})`

/**
 * Scoped to the viewer: a row exists only where the viewer may read the project and the listed
 * user belongs to it. The viewer keeps their own row even with no project, so a first-time
 * account sees itself rather than an empty page.
 */
export const listSyncStatus = (db: Db, viewerId: string): Promise<ReadonlyArray<SyncStatusRow>> =>
  db
    .select({
      userId: users.id,
      githubLogin: users.githubLogin,
      name: users.name,
      avatarUrl: users.avatarUrl,
      projectId: projects.id,
      projectName: projects.name,
      projectSlug: projects.slug,
      sessionCount,
      lastSyncedAt,
    })
    .from(users)
    .leftJoin(projects, and(memberOfProject(db, users.id), visibleToUser(db, viewerId)))
    .where(or(eq(users.id, viewerId), isNotNull(projects.id)))
    .orderBy(sql`${lastSyncedAt} desc nulls last`, asc(users.githubLogin), asc(projects.name))
