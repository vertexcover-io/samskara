import type { RepoIdentity } from "@samskara/core"
import { and, eq } from "drizzle-orm"
import type { Querier } from "../db/client.js"
import { repos } from "../db/schema.js"

/** Identity is (host, owner, repoName, userId) -- the rationale lives on the table in schema.ts. */
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
