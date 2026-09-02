import type { ProjectIdentity } from "@samskara/core"
import { type AnyColumn, aliasedTable, and, desc, eq, exists, or, type SQL, sql } from "drizzle-orm"
import type { Querier } from "../db/client.js"
import {
  orgs,
  projects,
  repos,
  sessionActivityAt,
  userOrgs,
  userProjectGrant,
  users,
} from "../db/schema.js"
import { type OwnerRef, ownerColumns } from "./ownerRef.js"

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

export const isSuperAdmin = (db: Querier, userId: string | AnyColumn): SQL | undefined =>
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

export type ProjectOwnerRef = OwnerRef

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
  const columns = ownerColumns(owner)
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

/** Exactly one of the pair is set -- guaranteed by `projects_one_owner_check`. */
export const ownerRefOf = async (
  db: Querier,
  projectId: string,
): Promise<ProjectOwnerRef | null> => {
  const [row] = await db
    .select({ ownerUserId: projects.ownerUserId, ownerOrgId: projects.ownerOrgId })
    .from(projects)
    .where(eq(projects.id, projectId))
  if (!row) return null
  return row.ownerOrgId !== null
    ? { kind: "org", orgId: row.ownerOrgId }
    : { kind: "user", userId: row.ownerUserId as string }
}

/** Sets the project's primary repo -- called once, from `findOrCreateProject`, after the repo
 * matching the project's own remote has been upserted with the project's own owner. */
export const setRepoId = async (db: Querier, projectId: string, repoId: string): Promise<void> => {
  await db.update(projects).set({ repoId }).where(eq(projects.id, projectId))
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
  readonly repoHost: string | null
  readonly repoOwner: string | null
  readonly repoName: string | null
}

const ownSessions = sql`"sessions" where "sessions"."projectId" = "projects"."id"`

export const sessionCount = sql<number>`(select count(*)::int from ${ownSessions})`

const lastActiveAt = sql<string | null>`(select max(${sessionActivityAt}) from ${ownSessions})`

const summaryColumns = {
  id: projects.id,
  name: projects.name,
  slug: projects.slug,
  ownerType: sql<
    "user" | "org"
  >`case when ${projects.ownerOrgId} is null then 'user' else 'org' end`,
  ownerSlug: sql<string>`coalesce(${orgs.githubSlug}, ${users.githubLogin})`,
  sessionCount,
  lastActiveAt,
  repoHost: repos.host,
  repoOwner: repos.owner,
  repoName: repos.repoName,
}

export const listAccessibleSummaries = (
  db: Querier,
  userId: string,
): Promise<ReadonlyArray<ProjectSummaryRow>> =>
  db
    .select(summaryColumns)
    .from(projects)
    .leftJoin(users, eq(users.id, projects.ownerUserId))
    .leftJoin(orgs, eq(orgs.id, projects.ownerOrgId))
    .leftJoin(repos, eq(repos.id, projects.repoId))
    .where(visibleToUser(db, userId))
    .orderBy(sql`${lastActiveAt} desc nulls last`, desc(projects.createdAt))

export const findVisibleSummaryById = async (
  db: Querier,
  userId: string,
  projectId: string,
): Promise<ProjectSummaryRow | null> => {
  const [row] = await db
    .select(summaryColumns)
    .from(projects)
    .leftJoin(users, eq(users.id, projects.ownerUserId))
    .leftJoin(orgs, eq(orgs.id, projects.ownerOrgId))
    .leftJoin(repos, eq(repos.id, projects.repoId))
    .where(and(eq(projects.id, projectId), visibleToUser(db, userId)))
  return row ?? null
}

export const canDelete = async (
  db: Querier,
  userId: string,
  projectId: string,
): Promise<boolean> => {
  const [row] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(
      and(
        eq(projects.id, projectId),
        or(eq(projects.ownerUserId, userId), isSuperAdmin(db, userId)),
      ),
    )
  return row !== undefined
}

export const remove = async (db: Querier, projectId: string): Promise<boolean> => {
  const deleted = await db
    .delete(projects)
    .where(eq(projects.id, projectId))
    .returning({ id: projects.id })
  return deleted.length > 0
}
