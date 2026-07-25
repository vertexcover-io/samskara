import type { RepoIdentity } from "@samskara/core"
import { and, eq } from "drizzle-orm"
import type { Querier } from "../db/client.js"
import { repos } from "../db/schema.js"

export const upsertByIdentity = async (db: Querier, identity: RepoIdentity): Promise<string> => {
  const [inserted] = await db
    .insert(repos)
    .values({ ...identity })
    .onConflictDoNothing({
      target: [repos.host, repos.owner, repos.ownerType, repos.repoName],
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
        eq(repos.ownerType, identity.ownerType),
        eq(repos.repoName, identity.repoName),
      ),
    )
  if (!existing) throw new Error("repo upsert resolved no row")
  return existing.id
}
