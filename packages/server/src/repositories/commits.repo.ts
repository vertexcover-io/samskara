import { asc, eq } from "drizzle-orm"
import type { Querier } from "../db/client.js"
import { commits, messages, sessions } from "../db/schema.js"

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

/**
 * The commit each of the session's messages was running on: the session's starting sha, advanced
 * by the commits the session made before that message. A commit's own message reports the sha it
 * ran against, so the head advances only after that message is mapped. A session that started
 * outside a repo has no starting sha and reports null until its first commit.
 *
 * Derived at read time from what phases 1 and 2 already store -- no git calls, no per-message
 * column. Drifts if HEAD moves outside a captured Bash call (an external commit, a checkout).
 */
export const headAtMessages = async (
  db: Querier,
  sessionId: string,
): Promise<ReadonlyMap<string, string | null>> => {
  const [session] = await db
    .select({ startCommit: sessions.startCommit })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
  if (!session) return new Map()

  const [ordered, made] = await Promise.all([
    db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(asc(messages.lineNumber), asc(messages.subIndex)),
    db
      .select({ sha: commits.sha, messageId: commits.messageId })
      .from(commits)
      .where(eq(commits.sessionId, sessionId)),
  ])

  const shaByMessageId = new Map(
    made.flatMap((commit) => (commit.messageId ? [[commit.messageId, commit.sha] as const] : [])),
  )

  const head = new Map<string, string | null>()
  let running: string | null = session.startCommit
  for (const { id } of ordered) {
    head.set(id, running)
    running = shaByMessageId.get(id) ?? running
  }
  return head
}
