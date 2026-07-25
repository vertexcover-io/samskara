import { eq, sql } from "drizzle-orm"
import type { PgColumn } from "drizzle-orm/pg-core"
import type { Querier } from "../db/client.js"
import { sessions } from "../db/schema.js"

export type SessionFields = {
  readonly title?: string
}

export type UpsertSessionInput = {
  readonly id: string
  readonly source: string
  readonly userId: string
  readonly projectId: string
  readonly fields: SessionFields
}

const keepExisting = (column: PgColumn) =>
  sql`coalesce(${sql.raw(`excluded."${column.name}"`)}, ${column})`

export const upsert = async (db: Querier, input: UpsertSessionInput): Promise<void> => {
  const { id, source, userId, projectId, fields } = input
  await db
    .insert(sessions)
    .values({
      id,
      source,
      userId,
      projectId,
      title: fields.title,
    })
    .onConflictDoUpdate({
      target: sessions.id,
      set: {
        title: keepExisting(sessions.title),
        updatedAt: sql`now()`,
      },
    })
}

export const exists = async (db: Querier, id: string): Promise<boolean> => {
  const [row] = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, id))
  return row !== undefined
}
