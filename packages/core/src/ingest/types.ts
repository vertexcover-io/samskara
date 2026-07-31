import { z } from "zod"

export const MSG_TYPES = [
  "message",
  "toolCall",
  "toolResult",
  "progress",
  "hookCall",
  "queueOperation",
  "turnEvent",
  "compaction",
  "localCommand",
  "fileEvent",
  "usage",
  "systemEvent",
  "custom",
] as const

const nonemptyString = z.string().min(1)
const nonnegativeInteger = z.number().int().nonnegative()
const jsonValue = z.unknown()
const timestamp = z.string().datetime({ offset: true })

export const tokenUsageSchema = z
  .object({
    input: nonnegativeInteger,
    output: nonnegativeInteger,
    cached: nonnegativeInteger,
    thinking: nonnegativeInteger,
  })
  .strict()

export const normalizedContentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), value: z.string() }).strict(),
  z
    .object({
      type: z.literal("reasoning"),
      value: z.string().optional(),
      signature: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("image"),
      value: nonemptyString,
      mediaType: nonemptyString,
      encoding: z.enum(["base64", "url"]),
    })
    .strict(),
])

const commonShape = {
  subIndex: nonnegativeInteger,
  sessionId: nonemptyString,
  source: z.literal("claude_code"),
  sourceSchemaVersion: z.number().int().positive(),
  trackId: nonemptyString,
  timestamp: timestamp.optional(),
  parentUuid: nonemptyString.optional(),
  model: nonemptyString.optional(),
  provider: nonemptyString.optional(),
  agentId: nonemptyString.optional(),
  gitBranch: nonemptyString.optional(),
  gitCommit: nonemptyString.optional(),
}

const tokenOwnerShape = { ...commonShape, tokens: tokenUsageSchema.optional() }

/** Conversation fields are copied from the transcript as-is, not mapped to our own vocabulary. */
const conversationDetailsSchema = z
  .object({
    origin: nonemptyString.optional(),
    promptSource: nonemptyString.optional(),
    deliveryMode: z.enum(["activeTurn", "turnBoundary"]).optional(),
    isMeta: z.boolean().optional(),
    sourceMessageId: nonemptyString.optional(),
  })
  .strict()

const toolCallDetailsSchema = z
  .object({ callId: nonemptyString, name: nonemptyString, input: jsonValue })
  .strict()
const toolResultDetailsSchema = z
  .object({
    callId: nonemptyString,
    output: jsonValue,
    status: z.enum(["success", "failure", "cancelled", "unknown"]),
  })
  .strict()
const progressDetailsSchema = z
  .object({
    progressType: nonemptyString,
    callId: nonemptyString.optional(),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    elapsedMs: nonnegativeInteger.optional(),
  })
  .strict()

const hookCommonShape = {
  type: nonemptyString,
  hookEvent: nonemptyString.optional(),
  hookName: nonemptyString.optional(),
  toolCallId: nonemptyString.optional(),
}
const hookCallDetailsSchema = z.discriminatedUnion("phase", [
  z
    .object({
      ...hookCommonShape,
      phase: z.literal("progress"),
      hookId: nonemptyString.optional(),
      command: z.string().optional(),
    })
    .strict(),
  z
    .object({
      ...hookCommonShape,
      phase: z.literal("result"),
      status: z.enum(["success", "failure", "cancelled", "unknown"]),
      hookId: nonemptyString.optional(),
      processId: nonemptyString.optional(),
      command: z.string().optional(),
      exitCode: z.number().int().optional(),
      stdout: z.string().optional(),
      stderr: z.string().optional(),
      durationMs: nonnegativeInteger.optional(),
      timedOut: z.boolean().optional(),
      timeoutMs: nonnegativeInteger.optional(),
      response: jsonValue.optional(),
    })
    .strict(),
  z
    .object({
      ...hookCommonShape,
      phase: z.literal("context"),
      additionalContext: jsonValue,
    })
    .strict(),
  z
    .object({
      phase: z.literal("summary"),
      type: nonemptyString,
      hookCount: nonnegativeInteger,
      hookInfos: z.array(
        z
          .object({ command: z.string().optional(), durationMs: nonnegativeInteger.optional() })
          .strict(),
      ),
      hookErrors: z.array(jsonValue),
      preventedContinuation: z.boolean(),
      stopReason: z.string().optional(),
      hasOutput: z.boolean().optional(),
    })
    .strict(),
])

const queueOperationDetailsSchema = z
  .object({
    operation: z.enum(["enqueue", "dequeue", "remove", "popAll", "unknown"]),
    taskId: nonemptyString.optional(),
    status: nonemptyString.optional(),
    summary: z.string().optional(),
    outputFile: nonemptyString.optional(),
    value: z.string().optional(),
  })
  .strict()
const turnEventDetailsSchema = z
  .object({
    type: z.enum(["duration", "aborted", "unknown"]),
    status: z.enum(["completed", "aborted", "unknown"]),
    durationMs: nonnegativeInteger.optional(),
    messageCount: nonnegativeInteger.optional(),
    pendingBackgroundAgentCount: nonnegativeInteger.optional(),
    pendingWorkflowCount: nonnegativeInteger.optional(),
    reason: z.string().optional(),
  })
  .strict()
const compactionDetailsSchema = z
  .object({
    type: z.enum(["boundary", "summary", "unknown"]),
    trigger: nonemptyString.optional(),
    summary: z.string().optional(),
    preTokens: nonnegativeInteger.optional(),
    postTokens: nonnegativeInteger.optional(),
    droppedTokens: nonnegativeInteger.optional(),
    durationMs: nonnegativeInteger.optional(),
    logicalParentUuid: nonemptyString.optional(),
    preservedMessageUuids: z.array(nonemptyString).optional(),
  })
  .strict()
const localCommandDetailsSchema = z
  .object({
    command: z.string().optional(),
    commandType: z.enum(["slash", "shell", "unknown"]).optional(),
    status: z.enum(["success", "failure", "cancelled", "unknown"]).optional(),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    exitCode: z.number().int().optional(),
  })
  .strict()

const fileEventDetailsSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("snapshot"),
      messageId: nonemptyString.optional(),
      isUpdate: z.boolean().optional(),
      snapshot: jsonValue,
    })
    .strict(),
  z
    .object({
      type: z.literal("delta"),
      messageId: nonemptyString.optional(),
      snapshotMessageId: nonemptyString.optional(),
      path: nonemptyString,
      backup: jsonValue,
    })
    .strict(),
  z
    .object({ type: z.literal("edited"), path: nonemptyString, snippet: z.string().optional() })
    .strict(),
  z.object({ type: z.literal("openedInIde"), path: nonemptyString }).strict(),
  z
    .object({
      type: z.literal("selectedInIde"),
      path: nonemptyString,
      lineStart: nonnegativeInteger,
      lineEnd: nonnegativeInteger,
      value: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("attached"),
      path: nonemptyString,
      displayPath: z.string().optional(),
      value: jsonValue.optional(),
      alreadyRead: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("artifact"),
      path: nonemptyString.optional(),
      url: nonemptyString.optional(),
      title: z.string().optional(),
    })
    .strict(),
])
const usageDetailsSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("tokens"), tokens: tokenUsageSchema }).strict(),
  z
    .object({
      type: z.literal("budget"),
      usedUsd: z.number().nonnegative(),
      totalUsd: z.number().nonnegative(),
      remainingUsd: z.number().nonnegative(),
    })
    .strict(),
])

export const normalizedMessageSchema = z.discriminatedUnion("msgType", [
  z
    .object({
      ...tokenOwnerShape,
      msgType: z.literal("message"),
      role: z.enum(["user", "assistant", "system", "developer", "unknown"]),
      content: normalizedContentSchema,
      details: conversationDetailsSchema.optional(),
    })
    .strict(),
  z
    .object({ ...tokenOwnerShape, msgType: z.literal("toolCall"), details: toolCallDetailsSchema })
    .strict(),
  z
    .object({
      ...tokenOwnerShape,
      msgType: z.literal("toolResult"),
      details: toolResultDetailsSchema,
    })
    .strict(),
  z
    .object({ ...tokenOwnerShape, msgType: z.literal("progress"), details: progressDetailsSchema })
    .strict(),
  z
    .object({ ...tokenOwnerShape, msgType: z.literal("hookCall"), details: hookCallDetailsSchema })
    .strict(),
  z
    .object({
      ...tokenOwnerShape,
      msgType: z.literal("queueOperation"),
      details: queueOperationDetailsSchema,
    })
    .strict(),
  z
    .object({
      ...tokenOwnerShape,
      msgType: z.literal("turnEvent"),
      details: turnEventDetailsSchema,
    })
    .strict(),
  z
    .object({
      ...tokenOwnerShape,
      msgType: z.literal("compaction"),
      details: compactionDetailsSchema,
    })
    .strict(),
  z
    .object({
      ...tokenOwnerShape,
      msgType: z.literal("localCommand"),
      details: localCommandDetailsSchema,
    })
    .strict(),
  z
    .object({
      ...tokenOwnerShape,
      msgType: z.literal("fileEvent"),
      details: fileEventDetailsSchema,
    })
    .strict(),
  z.object({ ...commonShape, msgType: z.literal("usage"), details: usageDetailsSchema }).strict(),
  z
    .object({ ...tokenOwnerShape, msgType: z.literal("systemEvent"), subType: nonemptyString })
    .strict(),
  z.object({ ...tokenOwnerShape, msgType: z.literal("custom"), subType: nonemptyString }).strict(),
])

export const parsedRecordSchema = z
  .object({
    lineUuid: z.string().uuid(),
    lineNumber: z.number().int().positive(),
    raw: jsonValue,
    messages: z.tuple([normalizedMessageSchema], normalizedMessageSchema).readonly(),
  })
  .strict()

export const projectIdentitySchema = z
  .object({ name: nonemptyString, slug: nonemptyString, root: nonemptyString.optional() })
  .strict()
export const agentInfoSchema = z
  .object({
    agentId: nonemptyString,
    agentType: nonemptyString.optional(),
    description: z.string().optional(),
    spawnDepth: nonnegativeInteger.optional(),
    spawnToolUseId: nonemptyString.optional(),
  })
  .strict()

const ingestBaseShape = {
  sessionId: nonemptyString,
  project: projectIdentitySchema,
  sourceRelativePath: nonemptyString,
  title: z.string().optional(),
  records: z.array(parsedRecordSchema).readonly(),
}

export const ingestPayloadSchema = z
  .discriminatedUnion("type", [
    z.object({ ...ingestBaseShape, type: z.literal("main") }).strict(),
    z.object({ ...ingestBaseShape, type: z.literal("subagent"), agent: agentInfoSchema }).strict(),
  ])
  .superRefine((payload, ctx) => {
    for (const [recordIndex, record] of payload.records.entries()) {
      for (const [messageIndex, message] of record.messages.entries()) {
        const path = ["records", recordIndex, "messages", messageIndex]
        if (message.sessionId !== payload.sessionId) {
          ctx.addIssue({
            code: "custom",
            path: [...path, "sessionId"],
            message: "session mismatch",
          })
        }
        if (payload.type === "main") {
          if (message.trackId !== "main") {
            ctx.addIssue({
              code: "custom",
              path: [...path, "trackId"],
              message: "main track required",
            })
          }
          if (message.agentId !== undefined) {
            ctx.addIssue({ code: "custom", path: [...path, "agentId"], message: "agent forbidden" })
          }
          continue
        }
        if (message.agentId !== payload.agent.agentId) {
          ctx.addIssue({ code: "custom", path: [...path, "agentId"], message: "agent mismatch" })
        }
        if (message.trackId !== `agent:${payload.agent.agentId}`) {
          ctx.addIssue({ code: "custom", path: [...path, "trackId"], message: "track mismatch" })
        }
      }
    }
  })

/**
 * Size caps shared by the CLI (which skips an oversize file rather than truncating it) and the
 * server (which does not trust that the client skipped).
 */
export const MAX_TEXT_BYTES = 5 * 1024 * 1024
export const MAX_BINARY_BYTES = 50 * 1024 * 1024
export const MAX_DIFF_BYTES = 1024 * 1024

/**
 * Lives beside `ingestPayloadSchema` for the same reason: the CLI builds this payload and the
 * server validates it, so one definition keeps the two from drifting.
 *
 * `encoding` is the client's classification of the bytes -- `base64` for binary, `utf8` for text.
 * The server derives `isBinary` from it rather than re-sniffing, because the client already
 * classified the file it read and the decoded bytes are what the hash covers.
 */
export const artifactUploadSchema = z
  .object({
    sessionId: nonemptyString,
    path: nonemptyString,
    relativePath: nonemptyString,
    mimeType: nonemptyString,
    changeKind: z.enum(["created", "edited", "editedUnknownBase"]),
    encoding: z.enum(["utf8", "base64"]),
    currentContent: z.string(),
    currentHash: nonemptyString,
    baseContent: z.string().optional(),
    baseHash: nonemptyString.optional(),
    diff: z.string().optional(),
    oldFragment: z.string().optional(),
    observedAt: timestamp,
  })
  .strict()

export type ArtifactUploadPayload = z.infer<typeof artifactUploadSchema>

export type ArtifactUploadResponse =
  | { readonly artifactId: string; readonly updated: boolean }
  | { readonly error: "hashMismatch" }
  | { readonly error: "artifactTooLarge" }
  | { readonly error: "sessionNotFound" }

export type MsgType = (typeof MSG_TYPES)[number]
export type TokenUsage = z.infer<typeof tokenUsageSchema>
export type NormalizedContent = z.infer<typeof normalizedContentSchema>
export type NormalizedMessage = z.infer<typeof normalizedMessageSchema>
export type ParsedRecord = z.infer<typeof parsedRecordSchema>
export type ProjectIdentity = z.infer<typeof projectIdentitySchema>
export type AgentInfo = z.infer<typeof agentInfoSchema>
export type IngestPayload = z.infer<typeof ingestPayloadSchema>

export type RepoIdentity = {
  readonly host: string
  readonly owner: string
  readonly ownerType: "user" | "org"
  readonly repoName: string
}

export type IngestResponse =
  | { readonly ingested: number; readonly deduped: number }
  | { readonly error: "sessionNotFound" }
  | { readonly error: "unauthorized" }
