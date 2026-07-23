import { inArray } from "drizzle-orm"
import type { Db } from "../db/client.js"
import { orgs } from "../db/schema.js"

export const findBySlugs = async (
  db: Db,
  slugs: ReadonlyArray<string>,
): Promise<ReadonlyArray<{ readonly id: string }>> =>
  db
    .select({ id: orgs.id })
    .from(orgs)
    .where(inArray(orgs.githubSlug, [...slugs]))

export const upsertBySlug = async (db: Db, slug: string): Promise<void> => {
  await db
    .insert(orgs)
    .values({ githubSlug: slug })
    .onConflictDoUpdate({
      target: orgs.githubSlug,
      set: { githubSlug: slug, updatedAt: new Date() },
    })
}
