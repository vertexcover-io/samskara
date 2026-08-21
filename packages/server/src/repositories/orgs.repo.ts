import { eq, inArray } from "drizzle-orm"
import type { Querier } from "../db/client.js"
import { orgs } from "../db/schema.js"

export type RegisteredOrg = {
  readonly id: string
  readonly githubSlug: string
  readonly autoAddMembers: boolean
}

export const findBySlugs = async (
  db: Querier,
  slugs: ReadonlyArray<string>,
): Promise<ReadonlyArray<RegisteredOrg>> =>
  db
    .select({ id: orgs.id, githubSlug: orgs.githubSlug, autoAddMembers: orgs.autoAddMembers })
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

export const upsertBySlug = async (
  db: Querier,
  slug: string,
  flags: { readonly autoAddMembers: boolean },
): Promise<void> => {
  await db
    .insert(orgs)
    .values({ githubSlug: slug, autoAddMembers: flags.autoAddMembers })
    .onConflictDoUpdate({
      target: orgs.githubSlug,
      set: { autoAddMembers: flags.autoAddMembers, updatedAt: new Date() },
    })
}
