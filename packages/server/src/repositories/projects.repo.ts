import type { ProjectIdentity } from "@samskara/core"
import { type AnyColumn, type SQL, aliasedTable, and, desc, eq, exists, or, sql } from "drizzle-orm"
import type { Querier } from "../db/client.js"
import { orgs, projects, userOrgs, userProjectGrant, users } from "../db/schema.js"

export const orgMemberOfProject = (db: Querier, userId: string | AnyColumn) =>
  exists(
    db
      .select({ one: sql`1` })
      .from(userOrgs)
      .where(and(eq(userOrgs.orgId, projects.ownerOrgId), eq(userOrgs.userId, userId))),
  )

/**
 * A predicate over a query that already has `projects` in scope: the user owns it, holds a grant
 * on it, or belongs to the org that owns it. `userId` may be a column so a join can correlate it
 * per row.
 */
export const memberOfProject = (db: Querier, userId: string | AnyColumn): SQL | undefined =>
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
    orgMemberOfProject(db, userId),
  )

/** Aliased so the EXISTS still resolves in queries that already have `users` in scope. */
const superUsers = aliasedTable(users, "superUsers")

/** Never fold into `memberOfProject` -- that asks about the row's user, not the viewer. */
const isSuperAdmin = (db: Querier, userId: string | AnyColumn): SQL | undefined =>
  exists(
    db
      .select({ one: sql`1` })
      .from(superUsers)
      .where(and(eq(superUsers.id, userId), eq(superUsers.isSuperAdmin, true))),
  )

/**
 * May this user read this project. One definition rather than a copy per repository: two
 * divergent copies of an authorization predicate is how one of them silently stops matching the
 * other. Distinct from `memberOfProject` because the two answer different questions -- a project
 * readable without membership would pair every user in the table with it if these were merged.
 */
export const visibleToUser = (db: Querier, userId: string | AnyColumn): SQL | undefined =>
  or(memberOfProject(db, userId), isSuperAdmin(db, userId))

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
  const [[owned], [member], [granted]] = await Promise.all([
    db
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(
          eq(projects.id, projectId),
          or(eq(projects.ownerUserId, userId), isSuperAdmin(db, userId)),
        ),
      ),
    db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), orgMemberOfProject(db, userId))),
    db
      .select({ scope: userProjectGrant.scope })
      .from(userProjectGrant)
      .where(and(eq(userProjectGrant.projectId, projectId), eq(userProjectGrant.userId, userId))),
  ])

  if (owned) return "admin"
  const grantScope = granted ? (granted.scope as Scope) : null
  if (!member) return grantScope
  return grantScope !== null && meetsScope(grantScope, "editor") ? grantScope : "editor"
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
