import { eq, inArray } from "drizzle-orm"
import type { Querier } from "../db/client.js"
import { orgs } from "../db/schema.js"

export const findBySlugs = async (
  db: Querier,
  slugs: ReadonlyArray<string>,
): Promise<ReadonlyArray<{ readonly id: string }>> =>
  db
    .select({ id: orgs.id })
    .from(orgs)
    .where(inArray(orgs.githubSlug, [...slugs]))

export const findBySlug = async (
  db: Querier,
  slug: string,
): Promise<{
  readonly id: string
  readonly githubSlug: string
  readonly autoAddMembers: boolean
} | null> => {
  const [row] = await db
    .select({ id: orgs.id, githubSlug: orgs.githubSlug, autoAddMembers: orgs.autoAddMembers })
    .from(orgs)
    .where(eq(orgs.githubSlug, slug))
  return row ?? null
}

export const upsertBySlug = async (db: Querier, slug: string): Promise<void> => {
  await db
    .insert(orgs)
    .values({ githubSlug: slug })
    .onConflictDoUpdate({
      target: orgs.githubSlug,
      set: { githubSlug: slug, updatedAt: new Date() },
    })
}
