import type { AgentInfo } from "@samskara/core"
import { and, eq, sql } from "drizzle-orm"
import type { PgColumn } from "drizzle-orm/pg-core"
import type { Querier } from "../db/client.js"
import { sessions, subagents } from "../db/schema.js"

export type UpsertSubagentInput = {
  readonly sessionId: string
  readonly sourceRelativePath: string
  readonly agent: AgentInfo
}

const keepExisting = (column: PgColumn) =>
  sql`coalesce(${sql.raw(`excluded."${column.name}"`)}, ${column})`

export const upsert = async (db: Querier, input: UpsertSubagentInput): Promise<void> => {
  const { sessionId, sourceRelativePath, agent } = input
  if (agent.parentAgentId)
    await db.execute(
      sql`select ${sessions.id} from ${sessions} where ${sessions.id} = ${sessionId} for update`,
    )
  const [parent] =
    agent.parentAgentId && agent.parentAgentId !== agent.agentId
      ? await db
          .select({ agentId: subagents.agentId })
          .from(subagents)
          .where(
            and(
              eq(subagents.sessionId, sessionId),
              eq(subagents.agentId, agent.parentAgentId),
              sql`not exists (
              with recursive ancestors as (
                select "agentId", "parentAgentId" from "subagents" where "sessionId" = ${sessionId} and "agentId" = ${agent.parentAgentId}
                union
                select p."agentId", p."parentAgentId" from "subagents" p join ancestors a on p."agentId" = a."parentAgentId" where p."sessionId" = ${sessionId}
              ) select 1 from ancestors where "agentId" = ${agent.agentId}
            )`,
            ),
          )
      : []
  await db
    .insert(subagents)
    .values({
      agentId: agent.agentId,
      sessionId,
      agentType: agent.agentType,
      description: agent.description,
      spawnDepth: agent.spawnDepth,
      spawnToolUseId: agent.spawnToolUseId,
      parentAgentId: parent?.agentId,
      sourceRelativePath,
    })
    .onConflictDoUpdate({
      target: [subagents.sessionId, subagents.agentId],
      set: {
        agentType: keepExisting(subagents.agentType),
        description: keepExisting(subagents.description),
        spawnDepth: keepExisting(subagents.spawnDepth),
        spawnToolUseId: keepExisting(subagents.spawnToolUseId),
        parentAgentId: keepExisting(subagents.parentAgentId),
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
