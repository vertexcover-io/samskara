import type { ToolCall, ToolResult } from "@samskara/core"
import { eq } from "drizzle-orm"
import type { Querier } from "../db/client.js"
import { toolCall, toolResult } from "../db/schema.js"

export const replaceForMessage = async (
  db: Querier,
  messageId: string,
  tool: { readonly call?: ToolCall; readonly result?: ToolResult },
): Promise<void> => {
  await db.delete(toolCall).where(eq(toolCall.messageId, messageId))
  await db.delete(toolResult).where(eq(toolResult.messageId, messageId))

  if (tool.call) {
    await db.insert(toolCall).values({
      toolId: tool.call.id,
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
