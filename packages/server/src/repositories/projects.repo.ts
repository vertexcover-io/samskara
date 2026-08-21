import type { ProjectIdentity } from "@samskara/core"
import { type SQL, and, desc, eq, exists, or, sql } from "drizzle-orm"
import type { Querier } from "../db/client.js"
import { orgs, projects, userOrgs, userProjectGrant, users } from "../db/schema.js"

/**
 * A predicate over a query that already has `projects` in scope. One definition rather than a
 * copy per repository: two divergent copies of an authorization predicate is how one of them
 * silently stops matching the other.
 */
export const visibleToUser = (db: Querier, userId: string): SQL | undefined =>
  or(
    eq(projects.ownerUserId, userId),
    exists(
      db
        .select({ one: sql`1` })
        .from(userProjectGrant)
        .where(
          and(eq(userProjectGrant.projectId, projects.id), eq(userProjectGrant.userId, userId)),
        ),
    ),
    exists(
      db
        .select({ one: sql`1` })
        .from(userOrgs)
        .where(and(eq(userOrgs.orgId, projects.ownerOrgId), eq(userOrgs.userId, userId))),
    ),
  )

export type UpsertProjectInput = {
  readonly identity: ProjectIdentity
  readonly ownerId: string
}

export type ProjectOwnerRef =
  | { readonly kind: "user"; readonly userId: string }
  | { readonly kind: "org"; readonly orgId: string }

export type UpsertOwnedInput = {
  readonly identity: Pick<ProjectIdentity, "name" | "slug">
  readonly owner: ProjectOwnerRef
}

export type Scope = "viewer" | "editor" | "admin"

const SCOPE_RANK: Readonly<Record<Scope, number>> = { viewer: 0, editor: 1, admin: 2 }

const meetsScope = (held: Scope, required: Scope): boolean =>
  SCOPE_RANK[held] >= SCOPE_RANK[required]

export const upsertOwned = async (
  db: Querier,
  { identity, owner }: UpsertOwnedInput,
): Promise<{ readonly id: string; readonly created: boolean }> => {
  const columns =
    owner.kind === "user" ? { ownerUserId: owner.userId } : { ownerOrgId: owner.orgId }
  const conflict =
    owner.kind === "user"
      ? {
          target: [projects.slug, projects.ownerUserId],
          targetWhere: sql`${projects.ownerOrgId} is null`,
        }
      : {
          target: [projects.slug, projects.ownerOrgId],
          targetWhere: sql`${projects.ownerUserId} is null`,
        }
  const [row] = await db
    .insert(projects)
    .values({ name: identity.name, slug: identity.slug, ...columns })
    .onConflictDoUpdate({ ...conflict, set: { name: identity.name, updatedAt: sql`now()` } })
    .returning({ id: projects.id, created: sql<boolean>`(xmax = 0)` })
  if (!row) throw new Error("project upsert resolved no row")
  return row
}

export const upsert = async (db: Querier, input: UpsertProjectInput): Promise<string> =>
  (
    await upsertOwned(db, {
      identity: input.identity,
      owner: { kind: "user", userId: input.ownerId },
    })
  ).id

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
    .where(and(eq(projects.id, projectId), eq(projects.ownerUserId, userId)))
  if (owned) return "admin"

  const [[member], [granted]] = await Promise.all([
    db
      .select({ id: projects.id })
      .from(projects)
      .innerJoin(userOrgs, eq(userOrgs.orgId, projects.ownerOrgId))
      .where(and(eq(projects.id, projectId), eq(userOrgs.userId, userId))),
    db
      .select({ scope: userProjectGrant.scope })
      .from(userProjectGrant)
      .where(and(eq(userProjectGrant.projectId, projectId), eq(userProjectGrant.userId, userId))),
  ])

  const held: Scope[] = [
    ...(member ? (["editor"] as const) : []),
    ...(granted ? ([granted.scope as Scope] as const) : []),
  ]
  if (held.length === 0) return null
  return held.reduce((best, scope) => (SCOPE_RANK[scope] > SCOPE_RANK[best] ? scope : best))
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
  readonly ownerType: "user" | "org"
  readonly ownerSlug: string
  readonly sessionCount: number
  readonly lastActiveAt: string | null
}

const ownSessions = sql`"sessions" where "sessions"."projectId" = "projects"."id"`

const sessionCount = sql<number>`(select count(*)::int from ${ownSessions})`

const lastActiveAt = sql<string | null>`(select max("sessions"."updatedAt") from ${ownSessions})`

export const listAccessibleSummaries = (
  db: Querier,
  userId: string,
): Promise<ReadonlyArray<ProjectSummaryRow>> =>
  db
    .select({
      id: projects.id,
      name: projects.name,
      slug: projects.slug,
      ownerType: sql<
        "user" | "org"
      >`case when ${projects.ownerOrgId} is null then 'user' else 'org' end`,
      ownerSlug: sql<string>`coalesce(${orgs.githubSlug}, ${users.githubLogin})`,
      sessionCount,
      lastActiveAt,
    })
    .from(projects)
    .leftJoin(users, eq(users.id, projects.ownerUserId))
    .leftJoin(orgs, eq(orgs.id, projects.ownerOrgId))
    .where(visibleToUser(db, userId))
    .orderBy(sql`${lastActiveAt} desc nulls last`, desc(projects.createdAt))
