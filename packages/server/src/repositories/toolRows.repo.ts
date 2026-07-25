import { eq } from "drizzle-orm"
import type { Querier } from "../db/client.js"
import { toolCall, toolResult } from "../db/schema.js"

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
