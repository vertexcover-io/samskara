import { eq } from "drizzle-orm"
import type { Querier } from "../db/client.js"
import { orgRepos, orgs } from "../db/schema.js"

export const findOrgIdBySlug = async (db: Querier, slug: string): Promise<string | null> => {
  const [org] = await db.select({ id: orgs.id }).from(orgs).where(eq(orgs.githubSlug, slug))
  return org?.id ?? null
}

export const link = async (db: Querier, orgId: string, repoId: string): Promise<void> => {
  await db.insert(orgRepos).values({ orgId, repoId }).onConflictDoNothing()
}
