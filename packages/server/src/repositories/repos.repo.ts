import type { RepoIdentity } from "@samskara/core"
import { and, eq } from "drizzle-orm"
import type { Querier } from "../db/client.js"
import { repos } from "../db/schema.js"

/**
 * Identity is (owner, repoName, userId) -- `host` and `ownerType` are stored but not keyed on.
 * `host` because one repo reached over ssh and https is one repo; `ownerType` because a remote
 * URL cannot distinguish a user from an org, and keying on an unknown would split one repo in two.
 */
export const upsertByIdentity = async (
  db: Querier,
  identity: RepoIdentity,
  userId: string,
): Promise<string> => {
  const [inserted] = await db
    .insert(repos)
    .values({ ...identity, userId })
    .onConflictDoNothing({
      target: [repos.owner, repos.repoName, repos.userId],
    })
    .returning({ id: repos.id })
  if (inserted) return inserted.id

  const [existing] = await db
    .select({ id: repos.id })
    .from(repos)
    .where(
      and(
        eq(repos.owner, identity.owner),
        eq(repos.repoName, identity.repoName),
        eq(repos.userId, userId),
      ),
    )
  if (!existing) throw new Error("repo upsert resolved no row")
  return existing.id
}
