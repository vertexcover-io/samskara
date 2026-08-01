import type { Querier } from "../db/client.js"
import { commits } from "../db/schema.js"

export type ObservedCommit = {
  readonly repoId: string
  readonly sha: string
  readonly branch?: string
  readonly subject?: string
  readonly filesChanged?: number
  readonly insertions?: number
  readonly deletions?: number
  readonly sessionId?: string
  readonly messageId?: string
}

/**
 * First observation wins. A sha's facts never change, so a re-parse of the same transcript must
 * not overwrite them -- which is why this is `onConflictDoNothing` and not the
 * last-write-wins-unless-null upsert `sessions.repo.ts` uses for a session's launch context.
 */
export const insertObserved = async (
  db: Querier,
  rows: ReadonlyArray<ObservedCommit>,
): Promise<void> => {
  if (rows.length === 0) return
  await db
    .insert(commits)
    .values([...rows])
    .onConflictDoNothing({ target: [commits.repoId, commits.sha] })
}
