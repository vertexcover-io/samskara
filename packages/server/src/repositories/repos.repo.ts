import type { RepoIdentity } from "@samskara/core"
import { and, eq, sql } from "drizzle-orm"
import type { Querier } from "../db/client.js"
import { orgs, repos, userOrgs } from "../db/schema.js"
import { type OwnerRef, ownerColumns } from "./projects.repo.js"

export type RepoOwnerRef = OwnerRef

/**
 * A repo belongs to the org whose name it sits under when its capturer is a member, and otherwise to
 * that capturer. Ownership follows the repo, not the project it was captured in, so a personal repo
 * touched inside an org's project stays personal.
 */
export const ownerFor = async (
  db: Querier,
  identity: RepoIdentity,
  userId: string,
): Promise<RepoOwnerRef> => {
  if (identity.host.toLowerCase() !== "github.com") return { kind: "user", userId }
  const [row] = await db
    .select({ orgId: orgs.id })
    .from(orgs)
    .innerJoin(userOrgs, and(eq(userOrgs.orgId, orgs.id), eq(userOrgs.userId, userId)))
    .where(sql`lower(${orgs.githubSlug}) = lower(${identity.owner})`)
  return row ? { kind: "org", orgId: row.orgId } : { kind: "user", userId }
}

/** The conflict target is left for Postgres to infer: the identity indexes are on `lower()` of each
 * column, and drizzle can only name plain ones. */
export const upsertByIdentity = async (
  db: Querier,
  identity: RepoIdentity,
  owner: RepoOwnerRef,
): Promise<string> => {
  const [inserted] = await db
    .insert(repos)
    .values({ ...identity, ...ownerColumns(owner) })
    .onConflictDoNothing()
    .returning({ id: repos.id })
  if (inserted) return inserted.id

  const [existing] = await db
    .select({ id: repos.id })
    .from(repos)
    .where(
      and(
        sql`lower(${repos.host}) = lower(${identity.host})`,
        sql`lower(${repos.owner}) = lower(${identity.owner})`,
        sql`lower(${repos.repoName}) = lower(${identity.repoName})`,
        owner.kind === "user"
          ? eq(repos.ownerUserId, owner.userId)
          : eq(repos.ownerOrgId, owner.orgId),
      ),
    )
  if (!existing) throw new Error("repo upsert resolved no row")
  return existing.id
}
