import { and, eq, notInArray, sql } from "drizzle-orm"
import type { Db, Querier } from "../db/client.js"
import { userOrgs } from "../db/schema.js"

export type MembershipPlan = {
  readonly add: ReadonlyArray<string>
  readonly keep: ReadonlyArray<string>
}

export const sync = (db: Db, userId: string, plan: MembershipPlan): Promise<void> =>
  db.transaction(async (tx) => {
    await tx
      .delete(userOrgs)
      .where(
        plan.keep.length === 0
          ? eq(userOrgs.userId, userId)
          : and(eq(userOrgs.userId, userId), notInArray(userOrgs.orgId, [...plan.keep])),
      )
    if (plan.add.length === 0) return
    await tx
      .insert(userOrgs)
      .values(plan.add.map((orgId) => ({ userId, orgId })))
      .onConflictDoNothing()
  })

export const isMember = async (db: Querier, userId: string, orgId: string): Promise<boolean> => {
  const [row] = await db
    .select({ one: sql`1` })
    .from(userOrgs)
    .where(and(eq(userOrgs.userId, userId), eq(userOrgs.orgId, orgId)))
  return row !== undefined
}
