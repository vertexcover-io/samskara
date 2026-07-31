import type { RepoIdentity } from "@samskara/core"
import { and, eq } from "drizzle-orm"
import type { Querier } from "../db/client.js"
import { repos } from "../db/schema.js"

/**
 * Identity is (host, owner, repoName, userId). `host` is part of it because github.com/acme/x and
 * gitlab.com/acme/x are different repos -- and keying on it does not split ssh from https, since
 * `parseRemote` yields the same host for both forms. `ownerType` is stored but NOT keyed on: a
 * remote URL cannot distinguish a user from an org, and keying on an unknown would split one repo.
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
      target: [repos.host, repos.owner, repos.repoName, repos.userId],
    })
    .returning({ id: repos.id })
  if (inserted) return inserted.id

  const [existing] = await db
    .select({ id: repos.id })
    .from(repos)
    .where(
      and(
        eq(repos.host, identity.host),
        eq(repos.owner, identity.owner),
        eq(repos.repoName, identity.repoName),
        eq(repos.userId, userId),
      ),
    )
  if (!existing) throw new Error("repo upsert resolved no row")
  return existing.id
}
