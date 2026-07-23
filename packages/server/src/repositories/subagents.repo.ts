import type { AgentInfo } from "@samskara/core"
import { sql } from "drizzle-orm"
import type { PgColumn } from "drizzle-orm/pg-core"
import type { Querier } from "../db/client.js"
import { subagents } from "../db/schema.js"

export type UpsertSubagentInput = {
  readonly sessionId: string
  readonly sourceRelativePath: string
  readonly agent: AgentInfo
}

const keepExisting = (column: PgColumn) =>
  sql`coalesce(${sql.raw(`excluded."${column.name}"`)}, ${column})`

export const upsert = async (db: Querier, input: UpsertSubagentInput): Promise<void> => {
  const { sessionId, sourceRelativePath, agent } = input
  await db
    .insert(subagents)
    .values({
      agentId: agent.agentId,
      sessionId,
      agentType: agent.agentType,
      description: agent.description,
      spawnDepth: agent.spawnDepth,
      spawnToolUseId: agent.spawnToolUseId,
      sourceRelativePath,
    })
    .onConflictDoUpdate({
      target: [subagents.sessionId, subagents.agentId],
      set: {
        agentType: keepExisting(subagents.agentType),
        description: keepExisting(subagents.description),
        spawnDepth: keepExisting(subagents.spawnDepth),
        spawnToolUseId: keepExisting(subagents.spawnToolUseId),
        updatedAt: sql`now()`,
      },
    })
}

export const resolveParentAgentIds = async (db: Querier, sessionId: string): Promise<void> => {
  await db.execute(sql`
    UPDATE "subagents" AS child
    SET "parentAgentId" = parent."agentId"
    FROM "toolCall" AS tc
    JOIN "messages" AS m ON m."id" = tc."messageId"
    JOIN "subagents" AS parent
      ON parent."agentId" = m."agentId"
    WHERE child."sessionId" = ${sessionId}
      AND parent."sessionId" = ${sessionId}
      AND child."parentAgentId" IS NULL
      AND child."spawnDepth" > 1
      AND tc."toolId" = child."spawnToolUseId"
      AND parent."agentId" <> child."agentId"
  `)
}
