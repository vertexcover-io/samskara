import { createHash } from "node:crypto"
import { basename, posix } from "node:path"
import type {
  AgentInfo,
  NormalizedMessage,
  ParsedRecord,
  ProjectIdentity,
  TokenUsage,
} from "../../ingest/types.js"
import { normalizedMessageSchema } from "../../ingest/types.js"
import type { FileSystem } from "../fs.js"
import { compact, iterJsonLines, readNewLines } from "../helpers.js"
import type {
  AgentPlugin,
  CheckpointBody,
  CheckpointOnlyTrack,
  CheckpointStore,
  CollectDeps,
  IngestSessionTrack,
  LineOutcome,
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
}

const normalizePath = (path: string): string => path.replaceAll("\\", "/")
const discoveryRootFor = (path: string): string | undefined => {
  const marker = "/.claude/projects/"
  const index = path.indexOf(marker)
  return index < 0 ? undefined : path.slice(0, index + marker.length - 1)
}

export const classifyClaudePath = (
  transcriptPath: string,
  discoveryRoot = discoveryRootFor(normalizePath(transcriptPath)),
): ClaudePathContext | null => {
  const normalized = normalizePath(transcriptPath)
  const rootRelative = discoveryRoot
    ? normalized.slice(normalizePath(discoveryRoot).replace(/\/$/, "").length + 1)
    : basename(normalized)
  const rootParts = rootRelative.split("/").filter(Boolean)
  const absoluteParts = normalized.split("/").filter(Boolean)
  const absoluteSubagentsIndex = absoluteParts.indexOf("subagents")
  const relativeParts = discoveryRoot
    ? rootParts.slice(1)
    : absoluteSubagentsIndex >= 1
      ? absoluteParts.slice(absoluteSubagentsIndex - 1)
      : rootParts
  const sourceRelativePath = relativeParts.join("/")

  if (/\/subagents\/workflows\/[^/]+\/journal\.jsonl$/.test(`/${sourceRelativePath}`)) {
    return null
  }

  const subagentsIndex = relativeParts.indexOf("subagents")
  if (subagentsIndex >= 1) {
    const sessionId = relativeParts[subagentsIndex - 1]
    if (!sessionId) return null
    const filename = relativeParts.at(-1) ?? ""
    const agentMatch = /^agent-(.+)\.jsonl$/.exec(filename)
    const agentId =
      agentMatch?.[1] ?? `path-${createHash("sha256").update(sourceRelativePath).digest("hex")}`
    return { sessionId, trackId: `agent:${agentId}`, agentId, sourceRelativePath }
  }

  const filename = relativeParts.at(-1) ?? basename(normalized)
  if (!filename.endsWith(".jsonl")) return null
  return {
    sessionId: filename.slice(0, -".jsonl".length),
    trackId: "main",
    sourceRelativePath: sourceRelativePath || filename,
  }
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

const baseFor = (data: Record<string, unknown>, context: ClaudeLineContext) => {
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
const knownPromptSource = (
  value: unknown,
): "typed" | "queued" | "sdk" | "system" | "unknown" | undefined => {
  if (value === undefined) return undefined
  if (value === "typed" || value === "queued" || value === "sdk" || value === "system") return value
  return "unknown"
}
const originKind = (value: unknown): string | undefined =>
  isObject(value) ? stringValue(value.kind) : stringValue(value)
const conversationDetailsFor = (
  data: Record<string, unknown>,
  role: ReturnType<typeof roleFor>,
  deliveryMode?: "activeTurn" | "turnBoundary",
) => {
  const promptSource = knownPromptSource(data.promptSource)
  const declaredOrigin = originKind(data.origin)
  const origin =
    declaredOrigin === "human"
      ? "human"
      : declaredOrigin === "task-notification"
        ? "taskNotification"
        : declaredOrigin === "coordinator"
          ? "coordinator"
          : role === "assistant"
            ? "assistant"
            : promptSource === "sdk"
              ? "sdk"
              : promptSource === "system" || data.isMeta === true
                ? "runtime"
                : "unknown"
  return {
    origin,
    promptSource,
    deliveryMode,
    isMeta: typeof data.isMeta === "boolean" ? data.isMeta : undefined,
    sourceMessageId: firstString(data.sourceMessageId, data.messageId),
  }
}

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
const custom = (base: ReturnType<typeof baseFor>, subType: string): NormalizedMessage =>
  parsedMessage({ ...base, subIndex: 0, msgType: "custom", subType })
const normalized = (
  base: ReturnType<typeof baseFor>,
  msgType: Exclude<NormalizedMessage["msgType"], "custom" | "systemEvent" | "message">,
  details: unknown,
): NormalizedMessage => parsedMessage({ ...base, subIndex: 0, msgType, details })
const systemEvent = (base: ReturnType<typeof baseFor>, subType: string): NormalizedMessage =>
  parsedMessage({ ...base, subIndex: 0, msgType: "systemEvent", subType })

const hookInfo = (value: unknown): { readonly command?: string; readonly durationMs?: number } => {
  if (!isObject(value)) return {}
  return {
    command: typeof value.command === "string" ? value.command : undefined,
    durationMs: nonnegativeIntegerValue(value.durationMs),
  }
}
const hookMessage = (
  data: Record<string, unknown>,
  base: ReturnType<typeof baseFor>,
): NormalizedMessage | undefined => {
  const type = stringValue(data.type)
  if (type === "hook_progress") {
    return normalized(base, "hookCall", {
      phase: "progress",
      type,
      ...hookAliases(data),
      command: typeof data.command === "string" ? data.command : undefined,
    })
  }
  if (type === "hook_additional_context") {
    if (!("content" in data)) return undefined
    return normalized(base, "hookCall", {
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
    return normalized(base, "hookCall", {
      phase: "result",
      type,
      status,
      ...hookResultFields(data),
    })
  }
  if (type === "async_hook_response") {
    return normalized(base, "hookCall", {
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
const localCommandMessage = (
  data: Record<string, unknown>,
  content: string,
  base: ReturnType<typeof baseFor>,
): NormalizedMessage => {
  const command =
    tagValue(content, "command-name") ??
    tagValue(content, "command-message") ??
    (typeof data.command === "string" ? data.command : undefined)
  const exitCode = integerValue(data.exitCode)
  const status = exitCode === undefined ? "unknown" : exitCode === 0 ? "success" : "failure"
  return normalized(base, "localCommand", {
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

const attachmentMessage = (
  attachment: Record<string, unknown>,
  base: ReturnType<typeof baseFor>,
): NormalizedMessage => {
  const type = stringValue(attachment.type) ?? "attachment"
  const hook = hookMessage(attachment, base)
  if (hook) return hook
  if (type === "queued_command") {
    if (typeof attachment.prompt !== "string") return custom(base, type)
    return parsedMessage({
      ...base,
      subIndex: 0,
      msgType: "message",
      role: "user",
      content: { type: "text", value: attachment.prompt },
      details: {
        ...conversationDetailsFor(attachment, "user", "activeTurn"),
        promptSource: "queued",
      },
    })
  }
  if (type === "read_truncation_notice") {
    return normalized(base, "progress", {
      progressType: "readTruncation",
      callId: stringValue(attachment.toolUseID),
      stdout: typeof attachment.banner === "string" ? attachment.banner : undefined,
    })
  }
  if (type === "date_change" || type === "auto_mode") return systemEvent(base, type)
  if (type === "budget_usd") {
    const usedUsd = finiteNonnegative(attachment.used)
    const totalUsd = finiteNonnegative(attachment.total)
    const remainingUsd = finiteNonnegative(attachment.remaining)
    return usedUsd === undefined || totalUsd === undefined || remainingUsd === undefined
      ? custom(base, type)
      : normalized(base, "usage", { type: "budget", usedUsd, totalUsd, remainingUsd })
  }
  const path = firstString(attachment.filename, attachment.path)
  if (type === "edited_text_file") {
    return path
      ? normalized(base, "fileEvent", {
          type: "edited",
          path,
          snippet: typeof attachment.snippet === "string" ? attachment.snippet : undefined,
        })
      : custom(base, type)
  }
  if (type === "file" || type === "already_read_file") {
    return path
      ? normalized(base, "fileEvent", {
          type: "attached",
          path,
          displayPath:
            typeof attachment.displayPath === "string" ? attachment.displayPath : undefined,
          value: attachment.value,
          alreadyRead: type === "already_read_file" ? true : undefined,
        })
      : custom(base, type)
  }
  if (type === "opened_file_in_ide") {
    return path ? normalized(base, "fileEvent", { type: "openedInIde", path }) : custom(base, type)
  }
  if (type === "selected_lines_in_ide") {
    const lineStart = nonnegativeIntegerValue(attachment.lineStart)
    const lineEnd = nonnegativeIntegerValue(attachment.lineEnd)
    return path && lineStart !== undefined && lineEnd !== undefined
      ? normalized(base, "fileEvent", {
          type: "selectedInIde",
          path,
          lineStart,
          lineEnd,
          value:
            typeof attachment.content === "string"
              ? attachment.content
              : typeof attachment.value === "string"
                ? attachment.value
                : undefined,
        })
      : custom(base, type)
  }
  return custom(base, type)
}

const systemMessage = (
  data: Record<string, unknown>,
  base: ReturnType<typeof baseFor>,
): NormalizedMessage => {
  const subType = stringValue(data.subtype) ?? "system"
  if (subType === "stop_hook_summary") {
    const hookInfos = Array.isArray(data.hookInfos) ? data.hookInfos.map(hookInfo) : []
    const hookErrors = Array.isArray(data.hookErrors) ? data.hookErrors : []
    return normalized(base, "hookCall", {
      phase: "summary",
      type: subType,
      hookCount: nonnegativeIntegerValue(data.hookCount) ?? hookInfos.length,
      hookInfos,
      hookErrors,
      preventedContinuation: data.preventedContinuation === true,
      stopReason: typeof data.stopReason === "string" ? data.stopReason : undefined,
      hasOutput: typeof data.hasOutput === "boolean" ? data.hasOutput : undefined,
    })
  }
  if (subType === "turn_duration") {
    const aborted = data.status === "aborted" || data.status === "interrupted"
    return normalized(base, "turnEvent", {
      type: aborted ? "aborted" : "duration",
      status: aborted ? "aborted" : "completed",
      durationMs: nonnegativeIntegerValue(data.durationMs),
      messageCount: nonnegativeIntegerValue(data.messageCount),
      pendingBackgroundAgentCount: nonnegativeIntegerValue(data.pendingBackgroundAgentCount),
      pendingWorkflowCount: nonnegativeIntegerValue(data.pendingWorkflowCount),
      reason: typeof data.reason === "string" ? data.reason : undefined,
    })
  }
  if (subType === "compact_boundary") {
    const metadata = isObject(data.compactMetadata) ? data.compactMetadata : data
    return normalized(base, "compaction", {
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
  if (subType === "local_command") {
    const content = typeof data.content === "string" ? data.content : ""
    return localCommandMessage(data, content, base)
  }
  const notices = new Set([
    "away_summary",
    "scheduled_task_fire",
    "informational",
    "model_refusal_fallback",
    "bridge_status",
    "date_change",
    "auto_mode",
  ])
  return notices.has(subType) ? systemEvent(base, subType) : custom(base, subType)
}

const progressMessage = (
  data: Record<string, unknown>,
  base: ReturnType<typeof baseFor>,
): NormalizedMessage => {
  const progress = isObject(data.data) ? data.data : undefined
  if (!progress) return custom(base, "progress")
  const type = stringValue(progress.type)
  if (!type) return custom(base, "progress")
  const hook = hookMessage(progress, base)
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
    return custom(base, type)
  }
  return normalized(base, "progress", { progressType: type, callId, stdout, stderr, elapsedMs })
}

const topLevelMessage = (
  data: Record<string, unknown>,
  base: ReturnType<typeof baseFor>,
): NormalizedMessage | undefined => {
  const type = stringValue(data.type)
  if (type === "attachment") {
    return isObject(data.attachment)
      ? attachmentMessage(data.attachment, base)
      : custom(base, "attachment")
  }
  if (type === "system") return systemMessage(data, base)
  if (type === "progress") return progressMessage(data, base)
  if (type === "summary") return systemEvent(base, "summary")
  if (type === "queue-operation") {
    const operation = data.operation
    const knownOperation =
      operation === "enqueue" ||
      operation === "dequeue" ||
      operation === "remove" ||
      operation === "popAll"
        ? operation
        : "unknown"
    return normalized(base, "queueOperation", {
      operation: knownOperation,
      taskId: stringValue(data.taskId),
      status: stringValue(data.status),
      summary: typeof data.summary === "string" ? data.summary : undefined,
      outputFile: stringValue(data.outputFile),
      value: typeof data.value === "string" ? data.value : undefined,
    })
  }
  if (type === "file-history-snapshot") {
    if (!("snapshot" in data)) return custom(base, type)
    return normalized(base, "fileEvent", {
      type: "snapshot",
      messageId: stringValue(data.messageId),
      isUpdate: typeof data.isUpdate === "boolean" ? data.isUpdate : undefined,
      snapshot: data.snapshot,
    })
  }
  if (type === "file-history-delta") {
    const path = stringValue(data.path)
    if (!path || !("backup" in data)) return custom(base, type)
    return normalized(base, "fileEvent", {
      type: "delta",
      messageId: stringValue(data.messageId),
      snapshotMessageId: stringValue(data.snapshotMessageId),
      path,
      backup: data.backup,
    })
  }
  if (type === "frame-link") {
    const path = stringValue(data.path)
    const url = stringValue(data.url)
    return path || url
      ? normalized(base, "fileEvent", {
          type: "artifact",
          path,
          url,
          title: typeof data.title === "string" ? data.title : undefined,
        })
      : custom(base, type)
  }
  return undefined
}

const blockMessage = (
  block: unknown,
  role: ReturnType<typeof roleFor>,
  base: ReturnType<typeof baseFor>,
  subIndex: number,
  details: ReturnType<typeof conversationDetailsFor>,
): NormalizedMessage => {
  const shared = { ...base, subIndex }
  if (!isObject(block)) {
    return parsedMessage({ ...shared, msgType: "custom", subType: "message.content" })
  }

  if (block.type === "text" && typeof block.text === "string") {
    return parsedMessage({
      ...shared,
      msgType: "message",
      role,
      content: { type: "text", value: block.text },
      details,
    })
  }
  if (block.type === "thinking") {
    return parsedMessage({
      ...shared,
      msgType: "message",
      role: "assistant",
      content: {
        type: "reasoning",
        value: typeof block.thinking === "string" ? block.thinking : undefined,
        signature: typeof block.signature === "string" ? block.signature : undefined,
      },
      details: { ...details, origin: "assistant" },
    })
  }
  if (block.type === "image") {
    const source = isObject(block.source) ? block.source : undefined
    const mediaType = firstString(source?.media_type, source?.mediaType)
    const encoding = source?.type === "base64" || source?.type === "url" ? source.type : undefined
    const value = firstString(source?.data, source?.url)
    if (mediaType && encoding && value) {
      return parsedMessage({
        ...shared,
        msgType: "message",
        role,
        content: { type: "image", value, mediaType, encoding },
        details,
      })
    }
  }
  if (block.type === "fallback") {
    return parsedMessage({ ...shared, msgType: "systemEvent", subType: "fallback" })
  }
  if (block.type === "tool_use") {
    const callId = stringValue(block.id)
    const name = stringValue(block.name)
    if (callId && name) {
      return parsedMessage({
        ...shared,
        msgType: "toolCall",
        details: { callId, name, input: block.input },
      })
    }
  }
  if (block.type === "tool_result") {
    const callId = stringValue(block.tool_use_id)
    if (callId) {
      const explicitStatus = stringValue(block.status)
      const status =
        explicitStatus === "success" ||
        explicitStatus === "failure" ||
        explicitStatus === "cancelled" ||
        explicitStatus === "unknown"
          ? explicitStatus
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
  }
  return parsedMessage({ ...shared, msgType: "custom", subType: contentSubtype(block) })
}

const withEmbeddedUsage = (
  messages: ReadonlyArray<NormalizedMessage>,
  usage: TokenUsage | undefined,
  base: ReturnType<typeof baseFor>,
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

export const normalizeClaude = (
  value: unknown,
  context: ClaudeLineContext = { sessionId: "unknown", trackId: "main", lineNumber: 1 },
): readonly [NormalizedMessage, ...NormalizedMessage[]] => {
  const data = isObject(value) ? value : {}
  const base = baseFor(data, context)
  const message = isObject(data.message) ? data.message : undefined
  const role = roleFor(message?.role)
  const content = message?.content
  const localCommand =
    typeof content === "string" && hasLocalCommandMarker(content)
      ? localCommandMessage(data, content, base)
      : undefined
  if (localCommand) return [localCommand]

  const topLevel = topLevelMessage(data, base)
  if (topLevel) return [topLevel]

  const deliveryMode = data.promptSource === "queued" ? "turnBoundary" : undefined
  const details = conversationDetailsFor(data, role, deliveryMode)
  if (typeof content === "string") {
    const conversation = parsedMessage({
      ...base,
      subIndex: 0,
      msgType: "message",
      role,
      content: { type: "text", value: content },
      details,
    })
    const messages = withEmbeddedUsage([conversation], tokensFrom(message?.usage), base)
    return [messages[0] ?? conversation, ...messages.slice(1)]
  }
  if (Array.isArray(content)) {
    const blocks = content.length === 0 ? [undefined] : content
    const messages = blocks.map((block, index) => blockMessage(block, role, base, index, details))
    const withUsage = withEmbeddedUsage(messages, tokensFrom(message?.usage), base)
    return [
      withUsage[0] ??
        parsedMessage({ ...base, subIndex: 0, msgType: "custom", subType: "message.content" }),
      ...withUsage.slice(1),
    ]
  }

  return [
    parsedMessage({ ...base, subIndex: 0, msgType: "custom", subType: fallbackSubtype(data) }),
  ]
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

type ParsedFile = {
  readonly path: string
  readonly context: ClaudePathContext
  readonly cwd?: string
  readonly outcomes: ReadonlyArray<LineOutcome>
  readonly stat: { readonly mtime: number; readonly size: number }
  readonly agent: AgentInfo | null
}

const checkpointAtFor =
  (stat: { readonly mtime: number; readonly size: number }) =>
  (lineNumber: number): CheckpointBody => ({
    source: SOURCE,
    mtime: stat.mtime,
    size: stat.size,
    lineProcessed: lineNumber,
  })

const completeObjects = (content: string): ReadonlyArray<Record<string, unknown>> =>
  iterJsonLines(
    content
      .split("\n")
      .slice(0, -1)
      .map((text, index) => ({ text, lineNumber: index + 1 })),
  ).flatMap((outcome) => (outcome.kind === "object" ? [outcome.data] : []))

const cwdFrom = (objects: ReadonlyArray<Record<string, unknown>>): string | undefined =>
  objects.map((object) => stringValue(object.cwd)).find((cwd) => cwd !== undefined)

const mainPathFor = (path: string, context: ClaudePathContext): string => {
  const normalized = normalizePath(path)
  const marker = "/subagents/"
  const index = normalized.indexOf(marker)
  if (index < 0) return path
  return `${posix.dirname(normalized.slice(0, index))}/${context.sessionId}.jsonl`
}

const fallbackMainCwd = async (
  fs: FileSystem,
  path: string,
  context: ClaudePathContext,
): Promise<string | undefined> => {
  if (!context.agentId) return undefined
  try {
    return cwdFrom(completeObjects(await fs.readFile(mainPathFor(path, context))))
  } catch {
    return undefined
  }
}

const parseFile = async (
  fs: FileSystem,
  path: string,
  context: ClaudePathContext,
  fromLine: number,
  deps: CollectDeps,
): Promise<ParsedFile> => {
  const stat = await fs.stat(path)
  const content = await fs.readFile(path)
  const { lines } = await readNewLines(fs, path, fromLine)
  const jsonOutcomes = iterJsonLines(lines)
  const cwd = cwdFrom(completeObjects(content)) ?? (await fallbackMainCwd(fs, path, context))
  const agent = context.agentId ? await readClaudeSidecar(fs, path) : null
  if (context.agentId) {
    try {
      const sidecar: unknown = JSON.parse(await fs.readFile(path.replace(/\.jsonl$/, ".meta.json")))
      if (isObject(sidecar)) {
        const sidecarAgentId = stringValue(sidecar.agentId)
        if (sidecarAgentId && sidecarAgentId !== context.agentId) {
          deps.log.warn(
            { path: context.sourceRelativePath },
            "Claude sidecar agent conflicts with filename",
          )
        }
      }
    } catch {
      // Missing or malformed sidecars fall back to filename identity.
    }
  }

  let blocked = false
  const outcomes = jsonOutcomes.flatMap((outcome): ReadonlyArray<LineOutcome> => {
    if (blocked) return []
    if (outcome.kind === "skip") {
      if (outcome.reason !== "blank") {
        deps.log.warn(
          {
            path: context.sourceRelativePath,
            lineNumber: outcome.lineNumber,
            reason: outcome.reason,
          },
          "Claude transcript line skipped",
        )
      }
      return [outcome]
    }

    const embeddedSessionId =
      stringValue(outcome.data.sessionId) ?? stringValue(outcome.data.session_id)
    if (embeddedSessionId && embeddedSessionId !== context.sessionId) {
      blocked = true
      deps.log.warn(
        { path: context.sourceRelativePath, lineNumber: outcome.lineNumber },
        "Claude transcript session conflicts with path",
      )
      return [{ kind: "blocked", lineNumber: outcome.lineNumber, reason: "contextConflict" }]
    }
    if (!cwd) {
      blocked = true
      return [{ kind: "blocked", lineNumber: outcome.lineNumber, reason: "unresolvedAttribution" }]
    }

    const redacted = redactJson(outcome.data)
    if (!isObject(redacted)) return []
    const lineContext: ClaudeLineContext = {
      sessionId: context.sessionId,
      trackId: context.trackId,
      lineNumber: outcome.lineNumber,
      agentId: context.agentId,
    }
    const nativeUuid = outcome.data.uuid
    if (
      nativeUuid !== undefined &&
      (typeof nativeUuid !== "string" || !UUID_PATTERN.test(nativeUuid))
    ) {
      deps.log.warn(
        { path: context.sourceRelativePath, lineNumber: outcome.lineNumber },
        "Claude transcript UUID is invalid; generated deterministic identity",
      )
    }
    const record: ParsedRecord = {
      lineUuid: lineUuidFor(lineContext, redacted, nativeUuid),
      lineNumber: outcome.lineNumber,
      raw: redacted,
      messages: normalizeClaude(redacted, lineContext),
    }
    return [{ kind: "record", lineNumber: outcome.lineNumber, record }]
  })

  return {
    path,
    context,
    cwd,
    outcomes,
    stat: { mtime: stat.mtimeMs, size: stat.size },
    agent: agent ? { ...agent, agentId: context.agentId ?? agent.agentId } : null,
  }
}

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

const checkpointOnlyTrack = (file: ParsedFile): CheckpointOnlyTrack => ({
  kind: "checkpointOnly",
  type: "main",
  sessionId: file.context.sessionId,
  sourceRelativePath: file.context.sourceRelativePath,
  checkpointKey: file.path,
  records: [],
  outcomes: file.outcomes,
  checkpointAt: checkpointAtFor(file.stat),
})

const ingestTrack = (file: ParsedFile, project: ProjectIdentity): IngestSessionTrack => {
  const records = file.outcomes.flatMap((outcome) =>
    outcome.kind === "record" ? [outcome.record] : [],
  )
  const shared = {
    kind: "ingest" as const,
    sessionId: file.context.sessionId,
    project,
    sourceRelativePath: file.context.sourceRelativePath,
    records,
    outcomes: file.outcomes,
    checkpointKey: file.path,
    checkpointAt: checkpointAtFor(file.stat),
  }
  if (file.context.agentId) {
    return {
      ...shared,
      type: "subagent",
      agent: file.agent ?? { agentId: file.context.agentId },
    }
  }
  return { ...shared, type: "main" }
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

export const createClaudePlugin = (fs: FileSystem): AgentPlugin => ({
  source: SOURCE,
  collect: async (prev, deps) => {
    const discovered = [...new Set(await deps.glob(GLOB))]
    const classified = compact(
      await Promise.all(
        discovered.map(async (path) => {
          const context = classifyClaudePath(path)
          if (!context) return null
          const stat = await fs.stat(path)
          return isChanged(prev, path, { mtime: stat.mtimeMs, size: stat.size })
            ? { path, context }
            : null
        }),
      ),
    )
    const files = await Promise.all(
      classified.map(({ path, context }) =>
        parseFile(fs, path, context, fromLineFor(prev, path), deps),
      ),
    )
    const tracks = compact(
      await Promise.all(
        files.map(async (file): Promise<SessionTrack | null> => {
          const hasRecord = file.outcomes.some((outcome) => outcome.kind === "record")
          if (!hasRecord) {
            const allSkips =
              file.outcomes.length > 0 && file.outcomes.every((outcome) => outcome.kind === "skip")
            return allSkips ? checkpointOnlyTrack(file) : null
          }
          if (!file.cwd) return null
          return ingestTrack(file, await deps.resolveProject(file.cwd))
        }),
      ),
    )
    return groupBySession(tracks)
  },
})
