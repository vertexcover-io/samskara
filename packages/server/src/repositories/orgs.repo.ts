import type { UpdateOrgRequest } from "@samskara/core"
import { and, eq, exists, inArray, or, type SQL, sql } from "drizzle-orm"
import type { Querier } from "../db/client.js"
import { orgs, projects, userOrgs, users } from "../db/schema.js"
import { isSuperAdmin, sessionCount } from "./projects.repo.js"

export type RegisteredOrg = {
  readonly id: string
  readonly githubSlug: string
  readonly autoAddMembers: boolean
}

export const findBySlugs = async (
  db: Querier,
  slugs: ReadonlyArray<string>,
): Promise<ReadonlyArray<RegisteredOrg>> =>
  db
    .select({ id: orgs.id, githubSlug: orgs.githubSlug, autoAddMembers: orgs.autoAddMembers })
    .from(orgs)
    .where(inArray(orgs.githubSlug, [...slugs]))

export const findBySlug = async (db: Querier, slug: string): Promise<RegisteredOrg | null> =>
  (await findBySlugs(db, [slug]))[0] ?? null

export const upsertBySlug = async (
  db: Querier,
  slug: string,
  flags: { readonly autoAddMembers: boolean },
): Promise<void> => {
  await db
    .insert(orgs)
    .values({ githubSlug: slug, autoAddMembers: flags.autoAddMembers })
    .onConflictDoUpdate({
      target: orgs.githubSlug,
      set: { autoAddMembers: flags.autoAddMembers, updatedAt: new Date() },
    })
}

const visibleOrgColumns = {
  id: orgs.id,
  githubSlug: orgs.githubSlug,
  name: sql<string>`coalesce(${orgs.name}, ${orgs.githubSlug})`,
}

export const registerBySlug = async (
  db: Querier,
  slug: string,
  flags: { readonly autoAddMembers: boolean },
): Promise<{ readonly org: VisibleOrg; readonly created: boolean }> => {
  const [inserted] = await db
    .insert(orgs)
    .values({ githubSlug: slug, autoAddMembers: flags.autoAddMembers })
    .onConflictDoNothing({ target: orgs.githubSlug })
    .returning(visibleOrgColumns)
  if (inserted) return { org: inserted, created: true }

  const [existing] = await db.select(visibleOrgColumns).from(orgs).where(eq(orgs.githubSlug, slug))
  if (!existing) throw new Error("org register resolved no row")
  return { org: existing, created: false }
}

export type OrgDetail = {
  readonly id: string
  readonly githubSlug: string
  readonly name: string
  readonly autoAddMembers: boolean
  readonly members: ReadonlyArray<{
    readonly id: string
    readonly githubLogin: string
    readonly avatarUrl: string | null
  }>
  readonly projects: ReadonlyArray<{
    readonly id: string
    readonly name: string
    readonly slug: string
    readonly sessionCount: number
  }>
  readonly sessionCount: number
}

const isVisible = (db: Querier, userId: string): SQL | undefined =>
  or(
    exists(
      db
        .select({ one: sql`1` })
        .from(userOrgs)
        .where(and(eq(userOrgs.orgId, orgs.id), eq(userOrgs.userId, userId))),
    ),
    isSuperAdmin(db, userId),
  )

export const isVisibleTo = async (db: Querier, userId: string, orgId: string): Promise<boolean> => {
  const [row] = await db
    .select({ id: orgs.id })
    .from(orgs)
    .where(and(eq(orgs.id, orgId), isVisible(db, userId)))
  return row !== undefined
}

export type VisibleOrg = {
  readonly id: string
  readonly githubSlug: string
  readonly name: string
}

export const listVisibleOrgs = async (
  db: Querier,
  userId: string,
): Promise<ReadonlyArray<VisibleOrg>> =>
  db
    .select({
      id: orgs.id,
      githubSlug: orgs.githubSlug,
      name: sql<string>`coalesce(${orgs.name}, ${orgs.githubSlug})`,
    })
    .from(orgs)
    .where(isVisible(db, userId))
    .orderBy(orgs.githubSlug)

export const findDetailBySlug = async (
  db: Querier,
  userId: string,
  slug: string,
): Promise<OrgDetail | null> => {
  const [org] = await db
    .select({
      id: orgs.id,
      githubSlug: orgs.githubSlug,
      name: sql<string>`coalesce(${orgs.name}, ${orgs.githubSlug})`,
      autoAddMembers: orgs.autoAddMembers,
    })
    .from(orgs)
    .where(and(eq(orgs.githubSlug, slug), isVisible(db, userId)))
  if (!org) return null

  const [members, projectRows] = await Promise.all([
    db
      .select({ id: users.id, githubLogin: users.githubLogin, avatarUrl: users.avatarUrl })
      .from(userOrgs)
      .innerJoin(users, eq(users.id, userOrgs.userId))
      .where(eq(userOrgs.orgId, org.id))
      .orderBy(users.githubLogin),
    db
      .select({ id: projects.id, name: projects.name, slug: projects.slug, sessionCount })
      .from(projects)
      .where(eq(projects.ownerOrgId, org.id))
      .orderBy(projects.name),
  ])

  return {
    ...org,
    members,
    projects: projectRows,
    sessionCount: projectRows.reduce((total, project) => total + project.sessionCount, 0),
  }
}

export const updateOrg = async (
  db: Querier,
  orgId: string,
  changes: Readonly<UpdateOrgRequest>,
): Promise<void> => {
  await db
    .update(orgs)
    .set({ ...changes, updatedAt: new Date() })
    .where(eq(orgs.id, orgId))
}
