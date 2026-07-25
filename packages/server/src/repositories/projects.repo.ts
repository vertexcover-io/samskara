import type { ProjectIdentity } from "@samskara/core"
import { and, eq, sql } from "drizzle-orm"
import type { Querier } from "../db/client.js"
import { projects, userProjectGrant } from "../db/schema.js"

export type UpsertProjectInput = {
  readonly identity: ProjectIdentity
  readonly ownerId: string
}

// Scopes are strictly ordered: viewer < editor < admin. A higher tier implies
// the lower ones (editor can view; admin can edit + view).
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

// Owner-or-grant authorization (P9). The owner is admin by derivation and has
// no grant row; grants only elevate OTHER users. Returns the effective scope, or
// null when the project is not visible to the user at all.
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
