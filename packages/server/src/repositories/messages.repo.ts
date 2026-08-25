import { and, eq, inArray } from "drizzle-orm"
import type { Querier } from "../db/client.js"
import { messages } from "../db/schema.js"

export type MessageRow = typeof messages.$inferInsert

export type MessageKey = `${string}:${number}`

export const keyOf = (lineUuid: string, subIndex: number): MessageKey => `${lineUuid}:${subIndex}`

export type InsertMessagesResult = {
  readonly ingested: number
  readonly deduped: number
  readonly idByKey: ReadonlyMap<MessageKey, string>
}

export const insertManyIgnoreConflicts = async (
  db: Querier,
  sessionId: string,
  rows: ReadonlyArray<MessageRow>,
): Promise<InsertMessagesResult> => {
  if (rows.length === 0) return { ingested: 0, deduped: 0, idByKey: new Map() }

  const inserted = await db
    .insert(messages)
    .values([...rows])
    .onConflictDoNothing({
      target: [messages.sessionId, messages.lineUuid, messages.subIndex],
    })
    .returning({ id: messages.id, lineUuid: messages.lineUuid, subIndex: messages.subIndex })

  const lineUuids = [...new Set(rows.map((r) => r.lineUuid))]
  const persisted = await db
    .select({ id: messages.id, lineUuid: messages.lineUuid, subIndex: messages.subIndex })
    .from(messages)
    .where(and(eq(messages.sessionId, sessionId), inArray(messages.lineUuid, lineUuids)))

  const idByKey = new Map(persisted.map((r) => [keyOf(r.lineUuid, r.subIndex), r.id] as const))

  return { ingested: inserted.length, deduped: rows.length - inserted.length, idByKey }
}
