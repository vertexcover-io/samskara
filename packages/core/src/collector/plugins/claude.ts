import { createHash } from "node:crypto"
import { basename, posix } from "node:path"
import { z } from "zod"
import type {
  AgentInfo,
  NormalizedMessage,
  ParsedRecord,
  ProjectIdentity,
  TokenUsage,
} from "../../ingest/types.js"
import { normalizedMessageSchema } from "../../ingest/types.js"
import type { FileSystem } from "../fs.js"
import { compact, completeLines, parseJsonLines } from "../helpers.js"
import type {
  AgentPlugin,
  CheckpointBody,
  CheckpointStore,
  CollectDeps,
  SessionBatch,
  SessionTrack,
} from "../types.js"

const SOURCE = "claude_code" as const
const SCHEMA_VERSION = 1
const GLOB = "~/.claude/projects/**/*.jsonl"
const URL_NAMESPACE = "6ba7b811-9dad-11d1-80b4-00c04fd430c8"
const SENSITIVE_KEYS = new Set([
  "token",
  "authorization",
  "password",
  "secret",
  "accesstoken",
  "refreshtoken",
  "apikey",
  "clientsecret",
])
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined
const nonnegativeInteger = (value: unknown): number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0
const normalizedKey = (key: string): string => key.toLowerCase().replaceAll(/[_-]/g, "")

export const redactJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redactJson)
  if (!isObject(value)) return value

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SENSITIVE_KEYS.has(normalizedKey(key)) ? "[Redacted]" : redactJson(item),
    ]),
  )
}

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!isObject(value)) return value
  return Object.fromEntries(
    Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => [key, stableValue(value[key])]),
  )
}

export const stableJson = (value: unknown): string => JSON.stringify(stableValue(value))

const uuidBytes = (uuid: string): Buffer => Buffer.from(uuid.replaceAll("-", ""), "hex")
const formatUuid = (bytes: Buffer): string => {
  const hex = bytes.toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const uuidV5 = (name: string): string => {
  const digest = createHash("sha1")
    .update(Buffer.concat([uuidBytes(URL_NAMESPACE), Buffer.from(name, "utf8")]))
    .digest()
    .subarray(0, 16)
  const bytes = Buffer.from(digest)
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  return formatUuid(bytes)
}

export type ClaudeLineContext = {
  readonly sessionId: string
  readonly trackId: string
  readonly lineNumber: number
  readonly agentId?: string
}

export const lineUuidFor = (
  context: ClaudeLineContext,
  redactedObject: unknown,
  nativeUuid?: unknown,
): string => {
  if (typeof nativeUuid === "string" && UUID_PATTERN.test(nativeUuid))
    return nativeUuid.toLowerCase()
  return uuidV5(
    stableJson([SOURCE, context.sessionId, context.trackId, context.lineNumber, redactedObject]),
  )
}

export type ClaudePathContext = {
  readonly sessionId: string
  readonly trackId: string
  readonly agentId?: string
  readonly sourceRelativePath: string
  readonly projectDir: string
}

const normalizePath = (path: string): string => path.replaceAll("\\", "/")
export const discoveryRootFor = (path: string): string | undefined => {
  const marker = "/.claude/projects/"
  const index = normalizePath(path).indexOf(marker)
  return index < 0 ? undefined : normalizePath(path).slice(0, index + marker.length - 1)
}

const MAIN_PATH = /^[^/]+\/([^/]+\.jsonl)$/
const SUBAGENT_PATH = /^[^/]+\/(([^/]+)\/subagents\/(?:.+\/)?(agent-(.+)\.jsonl|[^/]+\.jsonl))$/
const WORKFLOW_JOURNAL_PATH = /\/subagents\/workflows\/[^/]+\/journal\.jsonl$/

export const classifyClaudePath = (
  transcriptPath: string,
  discoveryRoot: string,
): ClaudePathContext | null => {
  const normalized = normalizePath(transcriptPath)
  const rootRelative = normalized.slice(normalizePath(discoveryRoot).replace(/\/$/, "").length + 1)
  const projectDir = rootRelative.slice(0, rootRelative.indexOf("/"))
  const mainMatch = MAIN_PATH.exec(rootRelative)
  const subagentMatch = SUBAGENT_PATH.exec(rootRelative)

  if (mainMatch) {
    const [, filename] = mainMatch
    if (!filename) return null
    return {
      sessionId: filename.slice(0, -".jsonl".length),
      trackId: "main",
      sourceRelativePath: filename,
      projectDir,
    }
  }

  if (subagentMatch && !WORKFLOW_JOURNAL_PATH.test(`/${rootRelative}`)) {
    const [, sourceRelativePath, sessionId, , namedAgentId] = subagentMatch
    if (!sessionId || !sourceRelativePath) return null
    const agentId =
      namedAgentId ?? `path-${createHash("sha256").update(sourceRelativePath).digest("hex")}`
    return { sessionId, trackId: `agent:${agentId}`, agentId, sourceRelativePath, projectDir }
  }

  return null
}

const roleFor = (role: unknown): "user" | "assistant" | "system" | "developer" | "unknown" => {
  if (role === "user" || role === "assistant" || role === "system" || role === "developer")
    return role
  return "unknown"
}
const providerFor = (model?: string): string | undefined =>
  model?.startsWith("claude-") ? "anthropic" : undefined

const tokensFrom = (usage: unknown): TokenUsage | undefined => {
  if (!isObject(usage)) return undefined
  return {
    input: nonnegativeInteger(usage.input_tokens),
    output: nonnegativeInteger(usage.output_tokens),
    cached: nonnegativeInteger(usage.cache_read_input_tokens),
    thinking: nonnegativeInteger(usage.thinking_tokens),
  }
}

const sourceTimestamp = (value: unknown): string | undefined => {
  const timestamp = stringValue(value)
  if (!timestamp || Number.isNaN(Date.parse(timestamp))) return undefined
  return /(Z|[+-]\d{2}:\d{2})$/.test(timestamp) ? timestamp : undefined
}

const fallbackSubtype = (data: Record<string, unknown>): string => {
  const topLevel = stringValue(data.type)
  if (topLevel === "system") return stringValue(data.subtype) ?? "system"
  if (topLevel === "attachment") {
    return isObject(data.attachment)
      ? (stringValue(data.attachment.type) ?? "attachment")
      : "attachment"
  }
  if (topLevel === "progress") {
    return isObject(data.data) ? (stringValue(data.data.type) ?? "progress") : "progress"
  }
  return topLevel ?? "unknown"
}

const contentSubtype = (block: unknown): string =>
  isObject(block) ? (stringValue(block.type) ?? "message.content") : "message.content"

const parseCommonFields = (data: Record<string, unknown>, context: ClaudeLineContext) => {
  const message = isObject(data.message) ? data.message : undefined
  const model = stringValue(message?.model)
  return {
    sessionId: context.sessionId,
    source: SOURCE,
    sourceSchemaVersion: SCHEMA_VERSION,
    trackId: context.trackId,
    timestamp: sourceTimestamp(data.timestamp),
    parentUuid: stringValue(data.parentUuid),
    model,
    provider: providerFor(model),
    agentId: context.agentId,
    gitBranch: stringValue(data.gitBranch),
    gitCommit: stringValue(data.gitSha) ?? stringValue(data.gitCommit),
  }
}

const parsedMessage = (value: unknown): NormalizedMessage => normalizedMessageSchema.parse(value)
const finiteNonnegative = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
const integerValue = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) ? value : undefined
const nonnegativeIntegerValue = (value: unknown): number | undefined => {
  const integer = integerValue(value)
  return integer !== undefined && integer >= 0 ? integer : undefined
}
const firstString = (...values: ReadonlyArray<unknown>): string | undefined =>
  values.map(stringValue).find((value) => value !== undefined)
/**
 * Copies the transcript's own conversation fields. `deliveryMode` is the one value we
 * derive: queued prompts land on a turn boundary unless the caller knows otherwise.
 */
const conversationDetailsFor = (
  data: Record<string, unknown>,
  deliveryMode: "activeTurn" | "turnBoundary" | undefined = data.promptSource === "queued"
    ? "turnBoundary"
    : undefined,
) => ({
  origin: isObject(data.origin) ? stringValue(data.origin.kind) : stringValue(data.origin),
  promptSource: stringValue(data.promptSource),
  deliveryMode,
  isMeta: typeof data.isMeta === "boolean" ? data.isMeta : undefined,
  sourceMessageId: firstString(data.sourceMessageId, data.messageId),
})

const hookAliases = (data: Record<string, unknown>) => ({
  hookEvent: stringValue(data.hookEvent),
  hookName: stringValue(data.hookName),
  hookId: stringValue(data.hookId),
  toolCallId: firstString(data.toolUseID, data.toolUseId, data.toolCallId),
})
const hookResultFields = (data: Record<string, unknown>) => ({
  ...hookAliases(data),
  processId: firstString(data.processId, data.pid),
  command: typeof data.command === "string" ? data.command : undefined,
  exitCode: integerValue(data.exitCode),
  stdout: typeof data.stdout === "string" ? data.stdout : undefined,
  stderr: typeof data.stderr === "string" ? data.stderr : undefined,
  durationMs: nonnegativeIntegerValue(data.durationMs),
  timedOut: typeof data.timedOut === "boolean" ? data.timedOut : undefined,
  timeoutMs: nonnegativeIntegerValue(data.timeoutMs),
  response: data.response,
})
const asyncHookStatus = (
  data: Record<string, unknown>,
): "success" | "failure" | "cancelled" | "unknown" => {
  if (data.cancelled === true || data.isCancelled === true) return "cancelled"
  const exitCode = integerValue(data.exitCode)
  if (exitCode !== undefined) return exitCode === 0 ? "success" : "failure"
  if (typeof data.success === "boolean") return data.success ? "success" : "failure"
  if (stringValue(data.error) || stringValue(data.stderr)) return "failure"
  return "unknown"
}
type CommonFields = ReturnType<typeof parseCommonFields>

const buildMessage = (common: CommonFields, fields: Record<string, unknown>): NormalizedMessage =>
  parsedMessage({ ...common, subIndex: 0, ...fields })

const detailedMessage = (
  common: CommonFields,
  msgType: Exclude<NormalizedMessage["msgType"], "custom" | "systemEvent" | "message">,
  details: unknown,
): NormalizedMessage => buildMessage(common, { msgType, details })

/** Validate `data` against `schema`; build a message from it, or fall back to `custom`. */
const buildParsed = <T>(
  schema: z.ZodType<T>,
  data: Record<string, unknown>,
  common: CommonFields,
  subType: string,
  build: (parsed: T) => NormalizedMessage,
): NormalizedMessage => {
  const parsed = schema.safeParse(data)
  return parsed.success
    ? build(parsed.data)
    : buildMessage(common, { msgType: "custom", subType: subType })
}

const hookSummaryEntry = (
  value: unknown,
): { readonly command?: string; readonly durationMs?: number } => {
  if (!isObject(value)) return {}
  return {
    command: typeof value.command === "string" ? value.command : undefined,
    durationMs: nonnegativeIntegerValue(value.durationMs),
  }
}
const handleHookMessage = (
  data: Record<string, unknown>,
  base: CommonFields,
): NormalizedMessage | undefined => {
  const type = stringValue(data.type)
  if (type === "hook_progress") {
    return detailedMessage(base, "hookCall", {
      phase: "progress",
      type,
      ...hookAliases(data),
      command: typeof data.command === "string" ? data.command : undefined,
    })
  }
  if (type === "hook_additional_context") {
    if (!("content" in data)) return undefined
    return detailedMessage(base, "hookCall", {
      phase: "context",
      type,
      hookEvent: stringValue(data.hookEvent),
      hookName: stringValue(data.hookName),
      toolCallId: firstString(data.toolUseID, data.toolUseId, data.toolCallId),
      additionalContext: data.content,
    })
  }
  if (type === "hook_success" || type === "hook_non_blocking_error" || type === "hook_cancelled") {
    const status =
      type === "hook_success" ? "success" : type === "hook_cancelled" ? "cancelled" : "failure"
    return detailedMessage(base, "hookCall", {
      phase: "result",
      type,
      status,
      ...hookResultFields(data),
    })
  }
  if (type === "async_hook_response") {
    return detailedMessage(base, "hookCall", {
      phase: "result",
      type,
      status: asyncHookStatus(data),
      ...hookResultFields(data),
    })
  }
  return undefined
}

const tagValue = (content: string, tag: string): string | undefined => {
  const opening = `<${tag}>`
  const closing = `</${tag}>`
  const start = content.indexOf(opening)
  if (start < 0) return undefined
  const valueStart = start + opening.length
  const end = content.indexOf(closing, valueStart)
  return end < 0 ? undefined : content.slice(valueStart, end)
}
const handleLocalCommandMessage = (
  data: Record<string, unknown>,
  content: string,
  base: CommonFields,
): NormalizedMessage => {
  const command =
    tagValue(content, "command-name") ??
    tagValue(content, "command-message") ??
    (typeof data.command === "string" ? data.command : undefined)
  const exitCode = integerValue(data.exitCode)
  const status = exitCode === undefined ? "unknown" : exitCode === 0 ? "success" : "failure"
  return detailedMessage(base, "localCommand", {
    command,
    commandType: command?.startsWith("/") ? "slash" : "unknown",
    status,
    stdout:
      tagValue(content, "local-command-stdout") ??
      (typeof data.stdout === "string" ? data.stdout : undefined),
    stderr: typeof data.stderr === "string" ? data.stderr : undefined,
    exitCode,
  })
}
const hasLocalCommandMarker = (content: string): boolean =>
  ["<local-command-caveat>", "<command-name>", "<command-message>"].some((marker) =>
    content.includes(marker),
  )

const optionalString = z.string().min(1).optional()
const nonnegativeNumber = z.number().finite().nonnegative()
const nonnegativeInt = z.number().int().nonnegative()
/** Builds a fileEvent, or undefined when the attachment names no path. */
const fileEventMessage = (
  attachment: Record<string, unknown>,
  common: CommonFields,
  type: string,
  fields: Record<string, unknown>,
): NormalizedMessage | undefined => {
  const path = firstString(attachment.filename, attachment.path)
  return path ? detailedMessage(common, "fileEvent", { type, path, ...fields }) : undefined
}

const budgetSchema = z.object({
  used: nonnegativeNumber,
  total: nonnegativeNumber,
  remaining: nonnegativeNumber,
})
const selectedLinesSchema = z.object({ lineStart: nonnegativeInt, lineEnd: nonnegativeInt })

const handleAttachmentMessage = (
  attachment: Record<string, unknown>,
  common: CommonFields,
): NormalizedMessage => {
  const type = stringValue(attachment.type) ?? "attachment"
  const hook = handleHookMessage(attachment, common)
  if (hook) return hook

  const asCustom = buildMessage(common, { msgType: "custom", subType: type })

  switch (type) {
    case "queued_command":
      return typeof attachment.prompt === "string"
        ? buildMessage(common, {
            msgType: "message",
            role: "user",
            content: { type: "text", value: attachment.prompt },
            details: {
              ...conversationDetailsFor(attachment, "activeTurn"),
              promptSource: "queued",
            },
          })
        : asCustom
    case "read_truncation_notice":
      return detailedMessage(common, "progress", {
        progressType: "readTruncation",
        callId: stringValue(attachment.toolUseID),
        stdout: typeof attachment.banner === "string" ? attachment.banner : undefined,
      })
    case "date_change":
    case "auto_mode":
      return buildMessage(common, { msgType: "systemEvent", subType: type })
    case "budget_usd":
      return buildParsed(budgetSchema, attachment, common, type, ({ used, total, remaining }) =>
        detailedMessage(common, "usage", {
          type: "budget",
          usedUsd: used,
          totalUsd: total,
          remainingUsd: remaining,
        }),
      )
    case "edited_text_file":
      return (
        fileEventMessage(attachment, common, "edited", {
          snippet: typeof attachment.snippet === "string" ? attachment.snippet : undefined,
        }) ?? asCustom
      )
    case "file":
    case "already_read_file":
      return (
        fileEventMessage(attachment, common, "attached", {
          displayPath:
            typeof attachment.displayPath === "string" ? attachment.displayPath : undefined,
          value: attachment.value,
          alreadyRead: type === "already_read_file" || undefined,
        }) ?? asCustom
      )
    case "opened_file_in_ide":
      return fileEventMessage(attachment, common, "openedInIde", {}) ?? asCustom
    case "selected_lines_in_ide":
      return buildParsed(
        selectedLinesSchema,
        attachment,
        common,
        type,
        (lines) =>
          fileEventMessage(attachment, common, "selectedInIde", {
            ...lines,
            value: firstString(attachment.content, attachment.value),
          }) ?? asCustom,
      )
    default:
      return asCustom
  }
}

/** `system` subtypes that carry no payload — recorded as bare timeline events. */
const NOTICE_SUBTYPES = new Set([
  "away_summary",
  "scheduled_task_fire",
  "informational",
  "model_refusal_fallback",
  "bridge_status",
  "date_change",
  "auto_mode",
])

const stopHookSummaryMessage = (
  data: Record<string, unknown>,
  common: CommonFields,
): NormalizedMessage => {
  const hookInfos = Array.isArray(data.hookInfos) ? data.hookInfos.map(hookSummaryEntry) : []
  return detailedMessage(common, "hookCall", {
    phase: "summary",
    type: "stop_hook_summary",
    hookCount: nonnegativeIntegerValue(data.hookCount) ?? hookInfos.length,
    hookInfos,
    hookErrors: Array.isArray(data.hookErrors) ? data.hookErrors : [],
    preventedContinuation: data.preventedContinuation === true,
    stopReason: typeof data.stopReason === "string" ? data.stopReason : undefined,
    hasOutput: typeof data.hasOutput === "boolean" ? data.hasOutput : undefined,
  })
}

const turnDurationMessage = (
  data: Record<string, unknown>,
  common: CommonFields,
): NormalizedMessage => {
  const aborted = data.status === "aborted" || data.status === "interrupted"
  return detailedMessage(common, "turnEvent", {
    type: aborted ? "aborted" : "duration",
    status: aborted ? "aborted" : "completed",
    durationMs: nonnegativeIntegerValue(data.durationMs),
    messageCount: nonnegativeIntegerValue(data.messageCount),
    pendingBackgroundAgentCount: nonnegativeIntegerValue(data.pendingBackgroundAgentCount),
    pendingWorkflowCount: nonnegativeIntegerValue(data.pendingWorkflowCount),
    reason: typeof data.reason === "string" ? data.reason : undefined,
  })
}

const compactBoundaryMessage = (
  data: Record<string, unknown>,
  common: CommonFields,
): NormalizedMessage => {
  const metadata = isObject(data.compactMetadata) ? data.compactMetadata : data
  return detailedMessage(common, "compaction", {
    type: "boundary",
    trigger: stringValue(metadata.trigger),
    summary: typeof metadata.summary === "string" ? metadata.summary : undefined,
    preTokens: nonnegativeIntegerValue(metadata.preTokens),
    postTokens: nonnegativeIntegerValue(metadata.postTokens),
    droppedTokens: nonnegativeIntegerValue(metadata.droppedTokens),
    durationMs: nonnegativeIntegerValue(metadata.durationMs),
    logicalParentUuid: stringValue(metadata.logicalParentUuid),
    preservedMessageUuids: Array.isArray(metadata.preservedMessageUuids)
      ? metadata.preservedMessageUuids.filter(
          (item): item is string => stringValue(item) !== undefined,
        )
      : undefined,
  })
}

const handleSystemMessage = (
  data: Record<string, unknown>,
  common: CommonFields,
): NormalizedMessage => {
  const subType = stringValue(data.subtype) ?? "system"
  switch (subType) {
    case "stop_hook_summary":
      return stopHookSummaryMessage(data, common)
    case "turn_duration":
      return turnDurationMessage(data, common)
    case "compact_boundary":
      return compactBoundaryMessage(data, common)
    case "local_command":
      return handleLocalCommandMessage(
        data,
        typeof data.content === "string" ? data.content : "",
        common,
      )
    default:
      return NOTICE_SUBTYPES.has(subType)
        ? buildMessage(common, { msgType: "systemEvent", subType: subType })
        : buildMessage(common, { msgType: "custom", subType: subType })
  }
}

const handleProgressMessage = (
  data: Record<string, unknown>,
  base: CommonFields,
): NormalizedMessage => {
  const progress = isObject(data.data) ? data.data : undefined
  if (!progress) return buildMessage(base, { msgType: "custom", subType: "progress" })
  const type = stringValue(progress.type)
  if (!type) return buildMessage(base, { msgType: "custom", subType: "progress" })
  const hook = handleHookMessage(progress, base)
  if (hook) return hook
  const callId = firstString(progress.toolUseID, progress.toolUseId, progress.toolCallId)
  const stdout = typeof progress.stdout === "string" ? progress.stdout : undefined
  const stderr = typeof progress.stderr === "string" ? progress.stderr : undefined
  const elapsedMs =
    nonnegativeIntegerValue(progress.elapsedMs) ??
    (() => {
      const seconds = finiteNonnegative(progress.elapsedTimeSeconds)
      const converted = seconds === undefined ? undefined : seconds * 1000
      return converted !== undefined && Number.isInteger(converted) ? converted : undefined
    })()
  if (!callId && stdout === undefined && stderr === undefined && elapsedMs === undefined) {
    return buildMessage(base, { msgType: "custom", subType: type })
  }
  return detailedMessage(base, "progress", {
    progressType: type,
    callId,
    stdout,
    stderr,
    elapsedMs,
  })
}

/** Requires `key` to be present on the object, even when its value may be undefined. */
const requiredKey = <T extends z.ZodTypeAny>(schema: T, key: string) =>
  schema.refine((value) => isObject(value) && key in value)

const queueOperationSchema = z.object({
  operation: z.enum(["enqueue", "dequeue", "remove", "popAll"]).catch("unknown" as never),
  taskId: optionalString,
  status: optionalString,
  summary: z.string().optional(),
  outputFile: optionalString,
  value: z.string().optional(),
})
const snapshotSchema = requiredKey(
  z.object({ snapshot: z.unknown(), messageId: optionalString, isUpdate: z.boolean().optional() }),
  "snapshot",
)
/**
 * Claude Code names the edited file `trackingPath` on a delta line. `path` is accepted too so an
 * older or renamed shape still parses, and both normalize to `path` for the rest of the pipeline.
 */
const deltaSchema = requiredKey(
  z
    .object({
      trackingPath: z.string().min(1).optional(),
      path: z.string().min(1).optional(),
      backup: z.unknown(),
      messageId: optionalString,
      snapshotMessageId: optionalString,
    })
    .transform(({ trackingPath, path, ...rest }) => ({ ...rest, path: trackingPath ?? path }))
    .refine((value): value is typeof value & { path: string } => value.path !== undefined),
  "backup",
)
const frameLinkSchema = z
  .object({ path: optionalString, url: optionalString, title: z.string().optional() })
  .refine((value) => value.path !== undefined || value.url !== undefined)

/**
 * Renders a line from its `message.content` — `user` and `assistant` lines, plus
 * any other type that carries conversational content.
 */
const handleConversationMessage = (
  data: Record<string, unknown>,
  common: CommonFields,
): readonly [NormalizedMessage, ...NormalizedMessage[]] => {
  const envelope = isObject(data.message) ? data.message : undefined
  const content = envelope?.content

  // A slash command is typed by its markers, not by the line's type field.
  if (typeof content === "string" && hasLocalCommandMarker(content)) {
    return [handleLocalCommandMessage(data, content, common)]
  }

  const role = roleFor(envelope?.role)
  const usage = tokensFrom(envelope?.usage)
  const details = conversationDetailsFor(data)

  if (typeof content === "string") {
    const conversation = buildMessage(common, {
      msgType: "message",
      role,
      content: { type: "text", value: content },
      details,
    })
    return nonEmpty(withEmbeddedUsage([conversation], usage, common))
  }

  if (Array.isArray(content)) {
    // An empty content array still yields one message, so the line is never dropped.
    const blocks = content.length === 0 ? [undefined] : content
    const messages = blocks.map((block, index) =>
      handleContentBlock(block, role, common, index, details),
    )
    return nonEmpty(withEmbeddedUsage(messages, usage, common))
  }

  return [buildMessage(common, { msgType: "custom", subType: fallbackSubtype(data) })]
}

const handleContentBlock = (
  block: unknown,
  role: ReturnType<typeof roleFor>,
  common: CommonFields,
  subIndex: number,
  details: ReturnType<typeof conversationDetailsFor>,
): NormalizedMessage => {
  const shared = { ...common, subIndex }
  if (!isObject(block)) {
    return parsedMessage({ ...shared, msgType: "custom", subType: "message.content" })
  }

  // Every arm falls back to this when the block is the right type but malformed.
  const asCustom = () =>
    parsedMessage({ ...shared, msgType: "custom", subType: contentSubtype(block) })

  switch (stringValue(block.type)) {
    case "text":
      return typeof block.text === "string"
        ? parsedMessage({
            ...shared,
            msgType: "message",
            role,
            content: { type: "text", value: block.text },
            details,
          })
        : asCustom()

    case "thinking":
      return parsedMessage({
        ...shared,
        msgType: "message",
        role: "assistant",
        content: {
          type: "reasoning",
          value: typeof block.thinking === "string" ? block.thinking : undefined,
          signature: typeof block.signature === "string" ? block.signature : undefined,
        },
        details,
      })

    case "image": {
      const source = isObject(block.source) ? block.source : undefined
      const mediaType = firstString(source?.media_type, source?.mediaType)
      const encoding = source?.type === "base64" || source?.type === "url" ? source.type : undefined
      const value = firstString(source?.data, source?.url)
      return mediaType && encoding && value
        ? parsedMessage({
            ...shared,
            msgType: "message",
            role,
            content: { type: "image", value, mediaType, encoding },
            details,
          })
        : asCustom()
    }

    case "fallback":
      return parsedMessage({ ...shared, msgType: "systemEvent", subType: "fallback" })

    case "tool_use": {
      const callId = stringValue(block.id)
      const name = stringValue(block.name)
      return callId && name
        ? parsedMessage({
            ...shared,
            msgType: "toolCall",
            details: { callId, name, input: block.input },
          })
        : asCustom()
    }

    case "tool_result": {
      const callId = stringValue(block.tool_use_id)
      if (!callId) return asCustom()
      const explicit = z
        .enum(["success", "failure", "cancelled", "unknown"])
        .safeParse(stringValue(block.status))
      const status = explicit.success
        ? explicit.data
        : block.is_error === true
          ? "failure"
          : block.is_error === false
            ? "success"
            : "unknown"
      return parsedMessage({
        ...shared,
        msgType: "toolResult",
        details: { callId, output: block.content, status },
      })
    }

    default:
      return asCustom()
  }
}

const withEmbeddedUsage = (
  messages: ReadonlyArray<NormalizedMessage>,
  usage: TokenUsage | undefined,
  base: CommonFields,
): ReadonlyArray<NormalizedMessage> => {
  if (!usage) return messages
  const assistantIndex = messages.findIndex(
    (message) => message.msgType === "message" && message.role === "assistant",
  )
  if (assistantIndex < 0) {
    return [
      ...messages,
      parsedMessage({
        ...base,
        subIndex: messages.length,
        msgType: "usage",
        details: { type: "tokens", tokens: usage },
      }),
    ]
  }
  return messages.map((message, index) =>
    index === assistantIndex ? parsedMessage({ ...message, tokens: usage }) : message,
  )
}

const nonEmpty = (
  messages: ReadonlyArray<NormalizedMessage>,
): readonly [NormalizedMessage, ...NormalizedMessage[]] => {
  const [first, ...rest] = messages
  if (!first) throw new Error("normalizeClaude produced no messages")
  return [first, ...rest]
}

export const normalizeClaude = (
  value: unknown,
  context: ClaudeLineContext = { sessionId: "unknown", trackId: "main", lineNumber: 1 },
): readonly [NormalizedMessage, ...NormalizedMessage[]] => {
  const data = isObject(value) ? value : {}
  const common = parseCommonFields(data, context)

  const type = stringValue(data.type)
  switch (type) {
    case "user":
    case "assistant":
      return handleConversationMessage(data, common)
    case "attachment":
      return [
        isObject(data.attachment)
          ? handleAttachmentMessage(data.attachment, common)
          : buildMessage(common, { msgType: "custom", subType: "attachment" }),
      ]
    case "system":
      return [handleSystemMessage(data, common)]
    case "progress":
      return [handleProgressMessage(data, common)]
    case "summary":
      return [buildMessage(common, { msgType: "systemEvent", subType: type })]
    case "queue-operation":
      return [
        buildParsed(queueOperationSchema, data, common, type, (details) =>
          detailedMessage(common, "queueOperation", details),
        ),
      ]
    case "file-history-snapshot":
      return [
        buildParsed(snapshotSchema, data, common, type, (details) =>
          detailedMessage(common, "fileEvent", { type: "snapshot", ...details }),
        ),
      ]
    case "file-history-delta":
      return [
        buildParsed(deltaSchema, data, common, type, (details) =>
          detailedMessage(common, "fileEvent", { type: "delta", ...details }),
        ),
      ]
    case "frame-link":
      return [
        buildParsed(frameLinkSchema, data, common, type, (details) =>
          detailedMessage(common, "fileEvent", { type: "artifact", ...details }),
        ),
      ]
    default:
      return handleConversationMessage(data, common)
  }
}

const pathAgentId = (transcriptPath: string): string | undefined =>
  /^agent-(.+)\.jsonl$/.exec(basename(normalizePath(transcriptPath)))?.[1]

export const readClaudeSidecar = async (
  fs: FileSystem,
  transcriptPath: string,
): Promise<AgentInfo | null> => {
  const agentId = pathAgentId(transcriptPath)
  if (!agentId) return null

  try {
    const parsed: unknown = JSON.parse(
      await fs.readFile(transcriptPath.replace(/\.jsonl$/, ".meta.json")),
    )
    if (!isObject(parsed)) return { agentId }
    return {
      agentId,
      agentType: stringValue(parsed.agentType),
      description: typeof parsed.description === "string" ? parsed.description : undefined,
      spawnDepth:
        typeof parsed.spawnDepth === "number" &&
        Number.isInteger(parsed.spawnDepth) &&
        parsed.spawnDepth >= 0
          ? parsed.spawnDepth
          : undefined,
      spawnToolUseId: stringValue(parsed.toolUseId) ?? stringValue(parsed.spawnToolUseId),
    }
  } catch {
    return { agentId }
  }
}

const checkpointAtFor =
  (stat: { readonly mtime: number; readonly size: number }) =>
  (lineNumber: number): CheckpointBody => ({
    source: SOURCE,
    mtime: stat.mtime,
    size: stat.size,
    lineProcessed: lineNumber,
  })

const cwdFrom = (
  lines: ReadonlyArray<{ readonly data: Record<string, unknown> }>,
): string | undefined =>
  lines.map(({ data }) => stringValue(data.cwd)).find((cwd) => cwd !== undefined)

const isChanged = (
  prev: CheckpointStore,
  path: string,
  stat: { readonly mtime: number; readonly size: number },
): boolean => {
  const checkpoint = prev.checkpoints[path]
  return !checkpoint || checkpoint.mtime !== stat.mtime || checkpoint.size !== stat.size
}
const fromLineFor = (prev: CheckpointStore, path: string): number =>
  prev.checkpoints[path]?.lineProcessed ?? 0

const firstTimestampIn = async (fs: FileSystem, path: string): Promise<string | undefined> => {
  try {
    const lines = parseJsonLines(completeLines(await fs.readFile(path)))
    return lines.map(({ data }) => sourceTimestamp(data.timestamp)).find((at) => at !== undefined)
  } catch {
    return undefined
  }
}

/**
 * A session starts when the first line of its MAIN transcript does. Judging per session rather than
 * per file keeps a subagent sidecar tied to its parent's fate, and an undatable session is kept —
 * losing data is worse than capturing slightly more than asked.
 */
const startsBefore = async (
  fs: FileSystem,
  files: ReadonlyArray<LocatedFile>,
  cutoff: string,
): Promise<boolean> => {
  const startedAt = await firstTimestampIn(fs, mainTranscriptPath(files))
  if (startedAt === undefined) return false
  return Date.parse(startedAt) < Date.parse(cutoff)
}

/**
 * The main transcript decides a session's age, but it is absent from a cycle that changed only a
 * sidecar. Its path is derived from any track's, so an old session cannot leak a subagent by
 * having already been checkpointed.
 */
const mainTranscriptPath = (files: ReadonlyArray<LocatedFile>): string => {
  const main = files.find(({ location }) => location.agentId === undefined)
  if (main) return main.path
  const [{ path, location }] = files as readonly [LocatedFile, ...LocatedFile[]]
  const suffix = `/${location.sourceRelativePath}`
  const dir = normalizePath(path).slice(0, -suffix.length)
  return `${dir}/${location.sessionId}.jsonl`
}

/** Drops every file of a session that started before the cutoff — never part of one. */
const withinCutoff = async (
  fs: FileSystem,
  files: ReadonlyArray<LocatedFile>,
  cutoff: string,
): Promise<ReadonlyArray<LocatedFile>> => {
  const bySession = new Map<string, LocatedFile[]>()
  for (const file of files) {
    const { sessionId } = file.location
    bySession.set(sessionId, [...(bySession.get(sessionId) ?? []), file])
  }

  const kept = await Promise.all(
    [...bySession.values()].map(async (sessionFiles) =>
      (await startsBefore(fs, sessionFiles, cutoff)) ? [] : sessionFiles,
    ),
  )
  return kept.flat()
}

const groupBySession = (tracks: ReadonlyArray<SessionTrack>): ReadonlyArray<SessionBatch> => {
  const grouped = new Map<string, ReadonlyArray<SessionTrack>>()
  for (const track of tracks) {
    grouped.set(track.sessionId, [...(grouped.get(track.sessionId) ?? []), track])
  }
  return [...grouped.entries()].map(([sessionId, tracks]) => ({
    sessionId,
    tracks: [...tracks].sort(
      (left, right) => Number(left.type === "subagent") - Number(right.type === "subagent"),
    ),
  }))
}

const collectTrack = async (
  fs: FileSystem,
  path: string,
  location: ClaudePathContext,
  fromLine: number,
  project: ProjectIdentity,
  deps: CollectDeps,
): Promise<SessionTrack | null> => {
  const stat = await fs.stat(path)
  const allLines = parseJsonLines(completeLines(await fs.readFile(path)))

  const records = allLines
    .filter(({ lineNumber }) => lineNumber > fromLine)
    .map(({ lineNumber, data }) => {
      const redacted = redactJson(data)
      const lineContext: ClaudeLineContext = {
        sessionId: location.sessionId,
        trackId: location.trackId,
        lineNumber,
        agentId: location.agentId,
      }
      return {
        lineUuid: lineUuidFor(lineContext, redacted, data.uuid),
        lineNumber,
        raw: redacted,
        messages: normalizeClaude(redacted, lineContext),
      }
    })
  if (records.length === 0) return null

  const shared = {
    sessionId: location.sessionId,
    project,
    sourceRelativePath: location.sourceRelativePath,
    records,
    checkpointKey: path,
    lastLineProcessed: allLines.at(-1)?.lineNumber ?? fromLine,
    checkpointAt: checkpointAtFor({ mtime: stat.mtimeMs, size: stat.size }),
  }
  if (!location.agentId) return { ...shared, type: "main" }

  const agent = await readClaudeSidecar(fs, path)
  return {
    ...shared,
    type: "subagent",
    agent: agent ? { ...agent, agentId: location.agentId } : { agentId: location.agentId },
  }
}

type LocatedFile = { readonly path: string; readonly location: ClaudePathContext }

/**
 * Every transcript under one `~/.claude/projects/<encoded-cwd>/` shares a cwd, subagents included,
 * so one probe decides the whole directory. The cwd is read from transcript content, never from the
 * directory name: the encoding flattens `/` and a literal `-` to the same character.
 *
 * Probing walks siblings until one answers, since a resumed transcript can have no cwd among its
 * new lines. The resolved identity is cached for the daemon's lifetime — a directory's cwd and git
 * remote are fixed — but an unresolved one is evicted so it stays retryable.
 */
const projectForDir = async (
  cache: Map<string, Promise<ProjectIdentity | null>>,
  fs: FileSystem,
  dir: string,
  files: ReadonlyArray<LocatedFile>,
  deps: CollectDeps,
): Promise<ProjectIdentity | null> => {
  const hit = cache.get(dir)
  if (hit) return hit

  const pending = (async () => {
    for (const { path } of files) {
      try {
        const cwd = cwdFrom(parseJsonLines(completeLines(await fs.readFile(path))))
        if (cwd) return await deps.resolveProject(cwd)
      } catch {
        // An unparseable sibling is reported when it is collected; keep probing.
      }
    }
    return null
  })()
  cache.set(dir, pending)

  const project = await pending
  if (!project) cache.delete(dir)
  return project
}

export const createClaudePlugin = (fs: FileSystem): AgentPlugin => {
  const projectByDir = new Map<string, Promise<ProjectIdentity | null>>()

  return {
    source: SOURCE,
    collect: async (prev, deps) => {
      const discovered = [...new Set(await deps.glob(GLOB))]

      // Locate and change-filter first, so an unchanged or unrecognized file costs no parsing.
      const changed = compact(
        await Promise.all(
          discovered.map(async (path): Promise<LocatedFile | null> => {
            const discoveryRoot = discoveryRootFor(path)
            if (!discoveryRoot) {
              deps.log.warn({ path }, "Claude transcript path missing .claude/projects root")
              return null
            }
            const location = classifyClaudePath(path, discoveryRoot)
            if (!location) {
              deps.log.warn({ path }, "Claude transcript path shape not supported")
              return null
            }
            const stat = await fs.stat(path)
            return isChanged(prev, path, { mtime: stat.mtimeMs, size: stat.size })
              ? { path, location }
              : null
          }),
        ),
      )

      const byDir = new Map<string, LocatedFile[]>()
      for (const file of changed) {
        byDir.set(file.location.projectDir, [...(byDir.get(file.location.projectDir) ?? []), file])
      }

      // Resolve and enablement-check per directory, before any transcript is normalized.
      const tracks = await Promise.all(
        [...byDir].map(async ([dir, files]): Promise<ReadonlyArray<SessionTrack | null>> => {
          const project = await projectForDir(projectByDir, fs, dir, files, deps)
          if (!project) {
            deps.log.warn({ dir }, "Claude project directory has no resolvable cwd")
            return []
          }
          if (deps.shouldCapture && !(await deps.shouldCapture(project))) return []

          const cutoff = await deps.syncFromFor?.(project)
          const eligible = cutoff === undefined ? files : await withinCutoff(fs, files, cutoff)

          return Promise.all(
            eligible.map(async ({ path, location }) => {
              try {
                return await collectTrack(
                  fs,
                  path,
                  location,
                  fromLineFor(prev, path),
                  project,
                  deps,
                )
              } catch (error) {
                deps.log.error(
                  { path: location.sourceRelativePath, err: error },
                  "Claude transcript skipped: unparseable line",
                )
                return null
              }
            }),
          )
        }),
      )
      return groupBySession(compact(tracks.flat()))
    },
  }
}
