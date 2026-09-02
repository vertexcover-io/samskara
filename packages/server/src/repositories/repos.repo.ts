import type { RepoIdentity } from "@samskara/core"
import { and, eq, sql } from "drizzle-orm"
import type { Querier } from "../db/client.js"
import { repos } from "../db/schema.js"
import { type OwnerRef, ownerColumns } from "./ownerRef.js"

export type RepoOwnerRef = OwnerRef

/**
 * Two clones of one repo can carry `ACME/Serana` and `acme/serana` in their remotes, and every
 * forge treats those as the same repo. The identity columns are case-sensitive, so they are folded
 * here rather than by each caller.
 *
 * `host: "local"` must not be folded: a remoteless repo is keyed by its absolute root path, and a
 * path is case-sensitive.
 */
const canonical = (identity: RepoIdentity): RepoIdentity => {
  const host = identity.host.toLowerCase()
  if (host === "local") return { ...identity, host }
  return {
    host,
    owner: identity.owner.toLowerCase(),
    repoName: identity.repoName.toLowerCase(),
  }
}

/** Identity is (host, owner, repoName, owner ref); `owner` picks both the column to write and the
 * partial-unique index that arbitrates the conflict. */
export const upsertByIdentity = async (
  db: Querier,
  raw: RepoIdentity,
  owner: RepoOwnerRef,
): Promise<string> => {
  const identity = canonical(raw)
  const columns = ownerColumns(owner)
  const conflict =
    owner.kind === "user"
      ? {
          target: [repos.host, repos.owner, repos.repoName, repos.ownerUserId],
          where: sql`${repos.ownerOrgId} is null`,
        }
      : {
          target: [repos.host, repos.owner, repos.repoName, repos.ownerOrgId],
          where: sql`${repos.ownerUserId} is null`,
        }

  const [inserted] = await db
    .insert(repos)
    .values({ ...identity, ...columns })
    .onConflictDoNothing(conflict)
    .returning({ id: repos.id })
  if (inserted) return inserted.id

  const ownerFilter =
    owner.kind === "user" ? eq(repos.ownerUserId, owner.userId) : eq(repos.ownerOrgId, owner.orgId)
  const [existing] = await db
    .select({ id: repos.id })
    .from(repos)
    .where(
      and(
        eq(repos.host, identity.host),
        eq(repos.owner, identity.owner),
        eq(repos.repoName, identity.repoName),
        ownerFilter,
      ),
    )
  if (!existing) throw new Error("repo upsert resolved no row")
  return existing.id
}
