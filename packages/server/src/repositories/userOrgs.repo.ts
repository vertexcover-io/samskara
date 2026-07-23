import type { Db } from "../db/client.js"
import { userOrgs } from "../db/schema.js"

export const linkMany = async (
  db: Db,
  userId: string,
  orgIds: ReadonlyArray<string>,
): Promise<void> => {
  if (orgIds.length === 0) return
  await db
    .insert(userOrgs)
    .values(orgIds.map((orgId) => ({ userId, orgId })))
    .onConflictDoNothing()
}
