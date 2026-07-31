import type { ProjectIdentity } from "@samskara/core"
import { type SQL, and, desc, eq, exists, or, sql } from "drizzle-orm"
import type { Querier } from "../db/client.js"
import { projects, userProjectGrant } from "../db/schema.js"

/**
 * Owner-or-grant, as a predicate over a query that already has `projects` in scope. One definition
 * rather than a copy per repository: two divergent copies of an authorization predicate is how one
 * of them silently stops matching the other.
 */
export const visibleToUser = (db: Querier, userId: string): SQL | undefined =>
  or(
    eq(projects.ownerId, userId),
    exists(
      db
        .select({ one: sql`1` })
        .from(userProjectGrant)
        .where(
          and(eq(userProjectGrant.projectId, projects.id), eq(userProjectGrant.userId, userId)),
        ),
    ),
  )

export type UpsertProjectInput = {
  readonly identity: ProjectIdentity
  readonly ownerId: string
}

export type Scope = "viewer" | "editor" | "admin"

const SCOPE_RANK: Readonly<Record<Scope, number>> = { viewer: 0, editor: 1, admin: 2 }

const meetsScope = (held: Scope, required: Scope): boolean =>
  SCOPE_RANK[held] >= SCOPE_RANK[required]

export const upsert = async (db: Querier, input: UpsertProjectInput): Promise<string> => {
  const { identity, ownerId } = input
  const [row] = await db
    .insert(projects)
    .values({ name: identity.name, slug: identity.slug, ownerId })
    .onConflictDoUpdate({
      target: [projects.slug, projects.ownerId],
      set: { name: identity.name, updatedAt: sql`now()` },
    })
    .returning({ id: projects.id })
  if (!row) throw new Error("project upsert resolved no row")
  return row.id
}

export const grant = async (
  db: Querier,
  userId: string,
  projectId: string,
  scope: Scope,
): Promise<void> => {
  await db
    .insert(userProjectGrant)
    .values({ userId, projectId, scope })
    .onConflictDoUpdate({
      target: [userProjectGrant.userId, userProjectGrant.projectId],
      set: { scope },
    })
}

export const authorityFor = async (
  db: Querier,
  userId: string,
  projectId: string,
): Promise<Scope | null> => {
  const [owned] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.ownerId, userId)))
  if (owned) return "admin"

  const [granted] = await db
    .select({ scope: userProjectGrant.scope })
    .from(userProjectGrant)
    .where(and(eq(userProjectGrant.projectId, projectId), eq(userProjectGrant.userId, userId)))
  return (granted?.scope as Scope | undefined) ?? null
}

export const canRead = async (db: Querier, userId: string, projectId: string): Promise<boolean> => {
  const scope = await authorityFor(db, userId, projectId)
  return scope !== null && meetsScope(scope, "viewer")
}

export const canWrite = async (
  db: Querier,
  userId: string,
  projectId: string,
): Promise<boolean> => {
  const scope = await authorityFor(db, userId, projectId)
  return scope !== null && meetsScope(scope, "editor")
}

export type ProjectSummaryRow = {
  readonly id: string
  readonly name: string
  readonly slug: string
  readonly sessionCount: number
  readonly lastActiveAt: string | null
  readonly lastSessionTitle: string | null
}

const ownSessions = sql`"sessions" where "sessions"."projectId" = "projects"."id"`

const sessionCount = sql<number>`(select count(*)::int from ${ownSessions})`

const lastActiveAt = sql<string | null>`(select max("sessions"."updatedAt") from ${ownSessions})`

const lastSessionTitle = sql<string | null>`(
  select "sessions"."title" from ${ownSessions}
  order by "sessions"."updatedAt" desc limit 1
)`

export const listAccessibleSummaries = (
  db: Querier,
  userId: string,
): Promise<ReadonlyArray<ProjectSummaryRow>> =>
  db
    .select({
      id: projects.id,
      name: projects.name,
      slug: projects.slug,
      sessionCount,
      lastActiveAt,
      lastSessionTitle,
    })
    .from(projects)
    .where(visibleToUser(db, userId))
    .orderBy(sql`${lastActiveAt} desc nulls last`, desc(projects.createdAt))
