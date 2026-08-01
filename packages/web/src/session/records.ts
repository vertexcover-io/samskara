import type {
  RawMessage,
  RawSubagent,
  RawToolCall,
  SessionDetailPayload,
  SessionFacts,
  TokenTotals,
} from "../api/types.js"

export type ToolEvidence = RawToolCall

type RecordBase = {
  readonly id: string
  readonly lineNumber: number
  readonly timestamp: string | null
  readonly agentId: string | null
  /** The captured messages this record stands for. Merging folds several into one block. */
  readonly sources: ReadonlyArray<string>
}

/**
 * One content block of a prompt. A turn that pasted a screenshot is captured as one row per
 * block, so a prompt holds an ordered run of these rather than a single body.
 */
export type PromptPart = { readonly id: string } & (
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "image"; readonly src: string }
)

export type TimelineRecord = RecordBase &
  (
    | { readonly kind: "prompt"; readonly parts: ReadonlyArray<PromptPart>; readonly actor: string }
    | {
        readonly kind: "assistant"
        readonly body: string
        readonly thinking: string | null
        readonly model: string | null
        readonly actor: string
        readonly block?: BlockStats
      }
    | { readonly kind: "tool"; readonly calls: ReadonlyArray<ToolEvidence> }
    | { readonly kind: "agentSpawn"; readonly agent: RawSubagent }
    | { readonly kind: "agentReturn"; readonly agent: RawSubagent }
    | { readonly kind: "artifact"; readonly artifact: Artifact }
    | {
        readonly kind: "command"
        readonly command: string
        readonly args: string
        readonly actor: string
      }
    | { readonly kind: "injection"; readonly label: string; readonly body: string }
    | { readonly kind: "event"; readonly label: string; readonly body: string }
  )

export type BlockStats = {
  readonly durationMs: number | null
  readonly toolCalls: number
  readonly messages: number
}

export type ArtifactAccess = "granted" | "denied"

export type Artifact = {
  readonly id: string
  readonly path: string | null
  readonly url: string | null
  readonly title: string | null
  readonly timestamp: string | null
  readonly content?: string | null
  readonly mimeType?: string | null
  readonly agent?: string | null
  readonly access?: ArtifactAccess
}

export type SessionDetail = {
  readonly session: SessionFacts
  readonly records: ReadonlyArray<TimelineRecord>
  readonly branches: ReadonlyMap<string, ReadonlyArray<TimelineRecord>>
  readonly agents: ReadonlyArray<RawSubagent>
  readonly toolCalls: ReadonlyArray<ToolEvidence>
  readonly tokenUsage: TokenTotals
}

const fields = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? { ...value } : null

const str = (value: unknown): string | null => (typeof value === "string" ? value : null)

const collectText = (value: unknown): string => {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map(collectText).filter(Boolean).join("\n\n")
  const shape = fields(value)
  if (!shape) return ""
  return str(shape.text) ?? str(shape.value) ?? str(shape.content) ?? str(shape.body) ?? ""
}

/** Capture names an assistant's thinking `reasoning`; other sources send it as `thinking`. */
const THINKING_TYPES = new Set(["thinking", "reasoning"])

const isThinking = (value: unknown): boolean => {
  const type = str(fields(value)?.type)
  return type !== null && THINKING_TYPES.has(type)
}

/**
 * Empty for anything that is not thinking. Encrypted thinking reaches us as a signature with no
 * text, which is every reasoning block this project has captured -- there the answer is also
 * empty, and the record discloses nothing rather than claiming its prose went missing.
 */
const thinkingTextOf = (value: unknown): string => {
  const shape = fields(value)
  if (shape === null) return ""
  const explicit = str(shape.thinking)
  if (explicit !== null) return explicit
  return isThinking(value) ? (str(shape.text) ?? str(shape.value) ?? "") : ""
}

const thinkingOf = (value: unknown): string | null => {
  const parts = (Array.isArray(value) ? value : [value])
    .map(thinkingTextOf)
    .filter((part) => part !== "")
  return parts.length === 0 ? null : parts.join("\n\n")
}

const proseOf = (value: unknown): string =>
  (Array.isArray(value) ? value : [value])
    .filter((part) => !isThinking(part))
    .map(collectText)
    .filter(Boolean)
    .join("\n\n")

/**
 * Captured images carry their own bytes, so they render without a round trip. A block whose
 * source cannot be addressed is dropped -- its `value` is raw base64, and letting it fall
 * through to `collectText` would spill the whole payload into the transcript as prose.
 */
const imageSrcOf = (shape: Readonly<Record<string, unknown>>): string | null => {
  const value = str(shape.value)
  if (value === null) return null
  if (str(shape.encoding) === "url") return value
  const mediaType = str(shape.mediaType)
  return str(shape.encoding) === "base64" && mediaType !== null
    ? `data:${mediaType};base64,${value}`
    : null
}

const promptPart = (value: unknown, id: string): PromptPart | null => {
  const shape = fields(value)
  if (shape?.type === "image") {
    const src = imageSrcOf(shape)
    return src === null ? null : { id, kind: "image", src }
  }
  const body = collectText(value)
  return body === "" ? null : { id, kind: "text", value: body }
}

const promptParts = (raw: RawMessage): ReadonlyArray<PromptPart> => {
  const blocks = Array.isArray(raw.content) ? raw.content : [raw.content]
  return blocks.flatMap((block, index) => {
    const part = promptPart(block, `${raw.id}:${index}`)
    return part === null ? [] : [part]
  })
}

/**
 * Half the `user` turns in a long session were never typed: capture stamps the ones the harness
 * injected with a subType, and these are the kinds it records. An unrecognised subType is left
 * alone -- a marker this reader does not know must never hide something the user did say.
 */
const INJECTION_LABELS: Readonly<Record<string, string>> = {
  compactSummary: "Context Continued",
  taskNotification: "Task Notification",
  systemReminder: "System Reminder",
  localCommand: "Command Output",
  toolInjection: "Tool Injection",
}

/** A skill body opens by naming its own directory, which is the only place the name appears. */
const SKILL_PREFIX = /^Base directory for this skill:\s*\S*?\/([^/\s]+)\s*$/m

const injectionLabel = (subType: string, body: string): string | null => {
  const label = INJECTION_LABELS[subType]
  if (label === undefined) return null
  if (subType !== "toolInjection") return label
  const skill = SKILL_PREFIX.exec(body)?.[1]
  return skill === undefined ? label : `Skill Loaded — ${skill}`
}

const SPAWN_TOOLS = new Set(["Agent", "Task"])

const SPAWN_SUBTYPES = new Set(["agentSpawn", "subagentSpawn", "spawn"])
const RETURN_SUBTYPES = new Set(["agentReturn", "subagentReturn", "return"])

const isArtifact = (raw: RawMessage): boolean =>
  raw.msgType === "fileEvent" && fields(raw.details)?.type === "artifact"

const artifactFrom = (raw: RawMessage): Artifact => {
  const details = fields(raw.details) ?? {}
  return {
    id: raw.id,
    path: str(details.path),
    url: str(details.url),
    title: str(details.title),
    timestamp: raw.timestamp,
    content: str(details.content) ?? str(details.snippet),
    mimeType: str(details.mimeType),
    agent: raw.agentId,
    access: str(details.access) === "denied" ? "denied" : "granted",
  }
}

const base = (raw: RawMessage): RecordBase => ({
  id: raw.id,
  lineNumber: raw.lineNumber,
  timestamp: raw.timestamp,
  agentId: raw.agentId,
  sources: [raw.id],
})

const eventLabel = (raw: RawMessage): string => raw.subType ?? raw.msgType

const actorFor = (
  raw: RawMessage,
  agents: ReadonlyMap<string, RawSubagent>,
  userLogin: string,
): string => {
  if (raw.role === "user") return raw.isSubagent ? "Parent → branch" : userLogin
  if (!raw.isSubagent || raw.agentId === null) return "Claude"
  const agent = agents.get(raw.agentId)
  return agent?.agentType ?? agent?.agentId ?? "Subagent"
}

const toRecord = (
  raw: RawMessage,
  callsByMessage: ReadonlyMap<string, ReadonlyArray<ToolEvidence>>,
  agents: ReadonlyMap<string, RawSubagent>,
  userLogin: string,
): TimelineRecord | null => {
  if (isArtifact(raw)) return { ...base(raw), kind: "artifact", artifact: artifactFrom(raw) }

  if (raw.subType !== null && raw.agentId !== null) {
    const agent = agents.get(raw.agentId)
    if (agent && SPAWN_SUBTYPES.has(raw.subType)) {
      return { ...base(raw), kind: "agentSpawn", agent }
    }
    if (agent && RETURN_SUBTYPES.has(raw.subType)) {
      return { ...base(raw), kind: "agentReturn", agent }
    }
  }

  if (raw.msgType === "toolCall" || raw.msgType === "toolResult") {
    const calls = callsByMessage.get(raw.id) ?? []
    // Results are joined onto their call, so a message carrying none is a duplicate of it.
    return calls.length === 0 ? null : { ...base(raw), kind: "tool", calls }
  }

  if (raw.msgType === "message" && raw.role === "user") {
    const body = collectText(raw.content)
    const label = raw.subType === null ? null : injectionLabel(raw.subType, body)
    if (label !== null) return { ...base(raw), kind: "injection", label, body }

    return {
      ...base(raw),
      kind: "prompt",
      parts: promptParts(raw),
      actor: actorFor(raw, agents, userLogin),
    }
  }

  // Only an invocation earns a record. The rest of what capture files as a localCommand is a
  // command's own output, which names nothing and belongs with the events.
  if (raw.msgType === "localCommand") {
    const details = fields(raw.details) ?? {}
    const command = str(details.command)
    if (command !== null) {
      return {
        ...base(raw),
        kind: "command",
        command,
        args: str(details.args) ?? "",
        actor: userLogin,
      }
    }
  }

  if (raw.msgType === "message") {
    return {
      ...base(raw),
      kind: "assistant",
      body: proseOf(raw.content),
      thinking: thinkingOf(raw.content),
      model: raw.model,
      actor: actorFor(raw, agents, userLogin),
    }
  }

  return {
    ...base(raw),
    kind: "event",
    label: eventLabel(raw),
    body: collectText(raw.content) || collectText(raw.details),
  }
}

const groupCalls = (
  calls: ReadonlyArray<ToolEvidence>,
): ReadonlyMap<string, ReadonlyArray<ToolEvidence>> => {
  const grouped = new Map<string, Array<ToolEvidence>>()
  for (const call of calls) {
    const existing = grouped.get(call.messageId)
    if (existing) existing.push(call)
    else grouped.set(call.messageId, [call])
  }
  return grouped
}

const belongsToBranch = (raw: RawMessage, agents: ReadonlyMap<string, RawSubagent>): boolean =>
  raw.isSubagent && raw.agentId !== null && agents.has(raw.agentId)

export const toDetail = (payload: SessionDetailPayload): SessionDetail => {
  const agents = new Map(payload.subagents.map((agent) => [agent.agentId, agent]))
  const callsByMessage = groupCalls(payload.toolCalls)

  const records: Array<TimelineRecord> = []
  const branches = new Map<string, Array<TimelineRecord>>()
  const spawned = new Set<string>()

  // Capture does not always emit a spawn event, but the Agent tool call that launched each branch
  // is on the track that made it -- the main spine for a top-level agent, the parent's branch for
  // a nested one. Pair them per track, in order, so a branch anchors to the call that started it.
  const pending = new Map<string | null, Array<RawSubagent>>()
  for (const agent of payload.subagents) {
    const siblings = pending.get(agent.parentAgentId)
    if (siblings) siblings.push(agent)
    else pending.set(agent.parentAgentId, [agent])
  }

  const trackOf = (track: string | null): Array<TimelineRecord> => {
    if (track === null) return records
    const existing = branches.get(track)
    if (existing) return existing
    const created: Array<TimelineRecord> = []
    branches.set(track, created)
    return created
  }

  for (const raw of payload.messages) {
    const record = toRecord(raw, callsByMessage, agents, payload.session.userLogin)
    if (record === null) continue

    const track = belongsToBranch(raw, agents) ? raw.agentId : null
    const into = trackOf(track)

    if (record.kind === "agentSpawn") spawned.add(record.agent.agentId)
    into.push(record)

    if (record.kind !== "tool") continue
    for (const call of record.calls) {
      if (!SPAWN_TOOLS.has(call.toolName)) continue
      const agent = pending.get(track)?.shift()
      if (agent === undefined || spawned.has(agent.agentId)) continue
      spawned.add(agent.agentId)
      // No sources: this marker is synthesised from the tool call rendered just above it, and
      // that message must resolve to the tool record rather than to whichever came last.
      into.push({
        ...base(raw),
        id: `spawn-${agent.agentId}`,
        sources: [],
        kind: "agentSpawn",
        agent,
      })
    }
  }

  return {
    session: payload.session,
    records,
    branches,
    agents: payload.subagents,
    toolCalls: payload.toolCalls,
    tokenUsage: payload.tokenUsage,
  }
}

const spanMs = (from: string | null, to: string | null): number | null => {
  if (from === null || to === null) return null
  const start = new Date(from).getTime()
  const end = new Date(to).getTime()
  return Number.isNaN(start) || Number.isNaN(end) || end < start ? null : end - start
}

const statsFor = (
  head: TimelineRecord,
  tail: TimelineRecord,
  messages: number,
  toolCalls: number,
): BlockStats => ({
  durationMs: spanMs(head.timestamp, tail.timestamp),
  toolCalls,
  messages,
})

/**
 * Capture splits a transcript line into one row per content block, which is what lets a tool
 * call hold its own identity. A prompt has no such need: its blocks are one thing the user
 * sent, so the rows sharing a line number are folded back into the turn they came from.
 */
const mergePromptTurns = (
  records: ReadonlyArray<TimelineRecord>,
): ReadonlyArray<TimelineRecord> => {
  const merged: Array<TimelineRecord> = []

  for (const record of records) {
    const previous = merged[merged.length - 1]
    const continues =
      record.kind === "prompt" &&
      previous !== undefined &&
      previous.kind === "prompt" &&
      previous.lineNumber === record.lineNumber &&
      previous.agentId === record.agentId

    if (!continues || previous === undefined || previous.kind !== "prompt") {
      merged.push(record)
      continue
    }

    merged[merged.length - 1] = {
      ...previous,
      parts: [...previous.parts, ...record.parts],
      sources: [...previous.sources, ...record.sources],
    }
  }

  return merged
}

const mergeAssistantRuns = (
  records: ReadonlyArray<TimelineRecord>,
  breakOnTools = false,
): ReadonlyArray<TimelineRecord> => {
  const merged: Array<TimelineRecord> = []
  let head: TimelineRecord | null = null
  let anchor = -1
  let messages = 0
  let toolCalls = 0

  const restamp = (start: TimelineRecord, tail: TimelineRecord): void => {
    const block = merged[anchor]
    if (block === undefined || block.kind !== "assistant") return
    merged[anchor] = { ...block, block: statsFor(start, tail, messages, toolCalls) }
  }

  for (const record of records) {
    const block = anchor === -1 ? undefined : merged[anchor]
    const start = head
    const continues =
      block !== undefined &&
      block.kind === "assistant" &&
      start !== null &&
      block.agentId === record.agentId &&
      (record.kind === "assistant" || record.kind === "tool")

    if (!continues || start === null || block === undefined || block.kind !== "assistant") {
      merged.push(record)
      head = record.kind === "assistant" ? record : null
      anchor = record.kind === "assistant" ? merged.length - 1 : -1
      messages = record.kind === "assistant" ? 1 : 0
      toolCalls = 0
      continue
    }

    // When tools are shown, a tool call closes the prose block so the stream
    // keeps its real execution order. When they are hidden, the surrounding
    // prose reads as one continuous answer instead.
    if (record.kind === "tool") {
      toolCalls += record.calls.length
      merged.push(record)
      restamp(start, record)
      if (breakOnTools) {
        head = null
        anchor = -1
      }
      continue
    }

    messages += 1
    const body = [block.body, record.body].filter((part) => part.trim() !== "").join("\n\n")
    merged[anchor] = {
      ...block,
      body,
      sources: [...block.sources, ...record.sources],
      model: block.model ?? record.model,
      thinking: block.thinking ?? record.thinking,
      block: statsFor(start, record, messages, toolCalls),
    }
  }

  return merged
}

export type ConversationView = {
  readonly records: ReadonlyArray<TimelineRecord>
  readonly branches: ReadonlyMap<string, ReadonlyArray<TimelineRecord>>
}

const shape = (
  records: ReadonlyArray<TimelineRecord>,
  withTools: boolean,
): ReadonlyArray<TimelineRecord> => {
  const merged = mergeAssistantRuns(
    mergePromptTurns(records.filter((record) => record.kind !== "event")),
    withTools,
  )
  return withTools ? merged : merged.filter((record) => record.kind !== "tool")
}

/**
 * The single path from captured records to rendered ones. Branches go through the same `shape`
 * as the main spine so a subagent's transcript can never drift from how the session reads.
 */
export const conversationView = (detail: SessionDetail, withTools: boolean): ConversationView => ({
  records: shape(detail.records, withTools),
  branches: new Map(
    [...detail.branches].map(([agentId, records]) => [agentId, shape(records, withTools)]),
  ),
})

/**
 * An agent and every agent above it. A nested branch renders inside its parent's annex, so
 * reaching one means opening the whole ancestry rather than the single branch that was named.
 */
export const ancestryOf = (
  agentId: string | null,
  agents: ReadonlyArray<RawSubagent>,
): ReadonlySet<string> => {
  const byId = new Map(agents.map((agent) => [agent.agentId, agent]))
  const chain = new Set<string>()
  let current = agentId
  while (current !== null && !chain.has(current)) {
    chain.add(current)
    current = byId.get(current)?.parentAgentId ?? null
  }
  return chain
}

export const anchorOf = (record: TimelineRecord): string =>
  record.kind === "agentSpawn" ? `spawn-${record.agent.agentId}` : `r-${record.id}`

export type MessageSite = {
  readonly agentId: string | null
  readonly anchor: string
}

/**
 * Where each captured message ended up on screen. Built per view, so a link resolves whether or
 * not inline tools are on -- the two modes merge assistant runs differently.
 */
export const locate = (view: ConversationView): ReadonlyMap<string, MessageSite> => {
  const sited = (records: ReadonlyArray<TimelineRecord>, agentId: string | null) =>
    records.flatMap((record) =>
      record.sources.map((source) => [source, { agentId, anchor: anchorOf(record) }] as const),
    )

  return new Map([
    ...sited(view.records, null),
    ...[...view.branches].flatMap(([agentId, records]) => sited(records, agentId)),
  ])
}

export const artifactsOf = (records: ReadonlyArray<TimelineRecord>): ReadonlyArray<Artifact> =>
  records.flatMap((record) => (record.kind === "artifact" ? [record.artifact] : []))
