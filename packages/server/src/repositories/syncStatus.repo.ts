import { and, asc, eq, exists, or, sql } from "drizzle-orm"
import type { Db } from "../db/client.js"
import { projects, userProjectGrant, users } from "../db/schema.js"
import { orgMemberOfProject } from "./projects.repo.js"

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

const memberOf = (db: Db) =>
  or(
    eq(projects.ownerUserId, users.id),
    exists(
      db
        .select({ one: sql`1` })
        .from(userProjectGrant)
        .where(
          and(eq(userProjectGrant.projectId, projects.id), eq(userProjectGrant.userId, users.id)),
        ),
    ),
    orgMemberOfProject(db, users.id),
  )

export const listSyncStatus = (db: Db): Promise<ReadonlyArray<SyncStatusRow>> =>
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
    .leftJoin(projects, memberOf(db))
    .orderBy(sql`${lastSyncedAt} desc nulls last`, asc(users.githubLogin), asc(projects.name))
