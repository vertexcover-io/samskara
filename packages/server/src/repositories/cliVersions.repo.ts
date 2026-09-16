import { sql } from "drizzle-orm"
import type { Querier } from "../db/client.js"
import { userCliVersion } from "../db/schema.js"

export type RecordCliVersionInput = {
  readonly userId: string
  readonly projectId: string
  readonly cliVersion: string
}

/**
 * `createdAt` is deliberately absent from the conflict update: it must keep the first sighting of
 * this version, because that date is what the sync page shows as "since". Only `updatedAt` moves.
 */
export const record = async (db: Querier, input: RecordCliVersionInput): Promise<void> => {
  await db
    .insert(userCliVersion)
    .values(input)
    .onConflictDoUpdate({
      target: [userCliVersion.userId, userCliVersion.projectId, userCliVersion.cliVersion],
      set: { updatedAt: sql`now()` },
    })
}
