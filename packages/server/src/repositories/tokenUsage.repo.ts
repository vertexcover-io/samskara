import type { TokenUsage } from "@samskara/core"
import type { Querier } from "../db/client.js"
import { tokenUsage } from "../db/schema.js"

export const upsert = async (db: Querier, messageId: string, tokens: TokenUsage): Promise<void> => {
  await db
    .insert(tokenUsage)
    .values({
      messageId,
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      cachedTokens: tokens.cached,
      thinkingTokens: tokens.thinking,
    })
    .onConflictDoUpdate({
      target: tokenUsage.messageId,
      set: {
        inputTokens: tokens.input,
        outputTokens: tokens.output,
        cachedTokens: tokens.cached,
        thinkingTokens: tokens.thinking,
      },
    })
}
