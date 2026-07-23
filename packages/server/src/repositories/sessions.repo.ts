import type { SessionFields } from "@samskara/core"
import { eq, sql } from "drizzle-orm"
import type { PgColumn } from "drizzle-orm/pg-core"
import type { Querier } from "../db/client.js"
import { sessions } from "../db/schema.js"

export type UpsertSessionInput = {
  readonly id: string
  readonly source: string
  readonly userId: string
  readonly repoId: string
  readonly fields: SessionFields
}

const providerFor = (model?: string): string | undefined =>
  model?.startsWith("claude-") ? "anthropic" : undefined

const keepExisting = (column: PgColumn) =>
  sql`coalesce(${sql.raw(`excluded."${column.name}"`)}, ${column})`

export const upsert = async (db: Querier, input: UpsertSessionInput): Promise<void> => {
  const { id, source, userId, repoId, fields } = input
  await db
    .insert(sessions)
    .values({
      id,
      source,
      userId,
      repoId,
      model: fields.model,
      provider: providerFor(fields.model),
      title: fields.title,
      cwd: fields.cwd,
      gitBranch: fields.gitBranch,
      gitCommit: fields.gitCommit,
      cliVersion: fields.cliVersion,
      permissionMode: fields.permissionMode,
    })
    .onConflictDoUpdate({
      target: sessions.id,
      set: {
        model: keepExisting(sessions.model),
        provider: keepExisting(sessions.provider),
        title: keepExisting(sessions.title),
        cwd: keepExisting(sessions.cwd),
        gitBranch: keepExisting(sessions.gitBranch),
        gitCommit: keepExisting(sessions.gitCommit),
        cliVersion: keepExisting(sessions.cliVersion),
        permissionMode: keepExisting(sessions.permissionMode),
        updatedAt: sql`now()`,
      },
    })
}

export const exists = async (db: Querier, id: string): Promise<boolean> => {
  const [row] = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, id))
  return row !== undefined
}
