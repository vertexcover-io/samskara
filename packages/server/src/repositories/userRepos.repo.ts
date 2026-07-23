import type { Querier } from "../db/client.js"
import { userRepos } from "../db/schema.js"

export const grant = async (db: Querier, userId: string, repoId: string): Promise<void> => {
  await db.insert(userRepos).values({ userId, repoId }).onConflictDoNothing()
}
