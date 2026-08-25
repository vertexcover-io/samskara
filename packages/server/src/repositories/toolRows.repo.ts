import { and, eq, inArray } from "drizzle-orm"
import type { Querier } from "../db/client.js"
import { messages, toolCall, toolResult } from "../db/schema.js"

type ToolProjection = {
  readonly call?: { readonly callId: string; readonly name: string; readonly input: unknown }
  readonly result?: {
    readonly callId: string
    readonly output: unknown
    readonly status: "success" | "failure" | "cancelled" | "unknown"
  }
}

export const replaceForMessage = async (
  db: Querier,
  messageId: string,
  tool: ToolProjection,
): Promise<void> => {
  await db.delete(toolCall).where(eq(toolCall.messageId, messageId))
  await db.delete(toolResult).where(eq(toolResult.messageId, messageId))

  if (tool.call) {
    await db.insert(toolCall).values({
      toolId: tool.call.callId,
      messageId,
      toolName: tool.call.name,
      toolInput: tool.call.input,
    })
  }
  if (tool.result) {
    await db.insert(toolResult).values({
      toolId: tool.result.callId,
      messageId,
      result: tool.result.output,
      status: tool.result.status,
    })
  }
}

export type StoredCall = {
  readonly messageId: string
  readonly toolName: string
  readonly command: string | null
  readonly repoId: string | null
}

const commandOf = (input: unknown): string | null => {
  if (typeof input !== "object" || input === null) return null
  const command = (input as Record<string, unknown>).command
  return typeof command === "string" && command.length > 0 ? command : null
}

/**
 * Session-scoped: a provider callId is only unique within one session's transcript, so a bare
 * toolId lookup could resolve another session's call.
 */
export const callsByIds = async (
  db: Querier,
  sessionId: string,
  callIds: ReadonlyArray<string>,
): Promise<ReadonlyMap<string, StoredCall>> => {
  if (callIds.length === 0) return new Map()
  const rows = await db
    .select({
      toolId: toolCall.toolId,
      messageId: toolCall.messageId,
      toolName: toolCall.toolName,
      toolInput: toolCall.toolInput,
      repoId: messages.repoId,
    })
    .from(toolCall)
    .innerJoin(messages, eq(messages.id, toolCall.messageId))
    .where(and(eq(messages.sessionId, sessionId), inArray(toolCall.toolId, [...callIds])))
  return new Map(
    rows.map((row) => [
      row.toolId,
      {
        messageId: row.messageId,
        toolName: row.toolName,
        command: commandOf(row.toolInput),
        repoId: row.repoId,
      },
    ]),
  )
}
