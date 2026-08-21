import { and, eq, sql } from "drizzle-orm"
import type { Querier } from "../db/client.js"
import { userOrgs } from "../db/schema.js"

export const linkMany = async (
  db: Querier,
  userId: string,
  orgIds: ReadonlyArray<string>,
): Promise<void> => {
  if (orgIds.length === 0) return
  await db
    .insert(userOrgs)
    .values(orgIds.map((orgId) => ({ userId, orgId })))
    .onConflictDoNothing()
}

export const isMember = async (db: Querier, userId: string, orgId: string): Promise<boolean> => {
  const [row] = await db
    .select({ one: sql`1` })
    .from(userOrgs)
    .where(and(eq(userOrgs.userId, userId), eq(userOrgs.orgId, orgId)))
  return row !== undefined
}
