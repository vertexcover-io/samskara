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
}

export type TimelineRecord = RecordBase &
  (
    | { readonly kind: "prompt"; readonly body: string; readonly actor: string }
    | {
        readonly kind: "assistant"
        readonly body: string
        readonly thinking: string | null
        readonly model: string | null
        readonly actor: string
      }
    | { readonly kind: "tool"; readonly calls: ReadonlyArray<ToolEvidence> }
    | { readonly kind: "agentSpawn"; readonly agent: RawSubagent }
    | { readonly kind: "agentReturn"; readonly agent: RawSubagent }
    | { readonly kind: "artifact"; readonly artifact: Artifact }
    | { readonly kind: "event"; readonly label: string; readonly body: string }
  )

export type Artifact = {
  readonly id: string
  readonly path: string | null
  readonly url: string | null
  readonly title: string | null
  readonly timestamp: string | null
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
  return str(shape.text) ?? str(shape.content) ?? str(shape.body) ?? ""
}

const thinkingOf = (value: unknown): string | null => {
  if (Array.isArray(value)) {
    const parts = value
      .map(fields)
      .filter((part): part is Readonly<Record<string, unknown>> => part !== null)
      .filter((part) => part.type === "thinking")
      .map((part) => str(part.thinking) ?? str(part.text) ?? "")
      .filter(Boolean)
    return parts.length === 0 ? null : parts.join("\n\n")
  }
  const shape = fields(value)
  return shape === null ? null : str(shape.thinking)
}

const proseOf = (value: unknown): string => {
  if (!Array.isArray(value)) return collectText(value)
  return value
    .filter((part) => fields(part)?.type !== "thinking")
    .map(collectText)
    .filter(Boolean)
    .join("\n\n")
}

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
  }
}

const base = (raw: RawMessage): RecordBase => ({
  id: raw.id,
  lineNumber: raw.lineNumber,
  timestamp: raw.timestamp,
  agentId: raw.agentId,
})

const eventLabel = (raw: RawMessage): string => raw.subType ?? raw.msgType

const actorFor = (raw: RawMessage, agents: ReadonlyMap<string, RawSubagent>): string => {
  if (raw.role === "user") return raw.isSubagent ? "Parent → branch" : "You"
  if (!raw.isSubagent || raw.agentId === null) return "Claude"
  const agent = agents.get(raw.agentId)
  return agent?.agentType ?? agent?.agentId ?? "Subagent"
}

const toRecord = (
  raw: RawMessage,
  callsByMessage: ReadonlyMap<string, ReadonlyArray<ToolEvidence>>,
  agents: ReadonlyMap<string, RawSubagent>,
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
    return { ...base(raw), kind: "tool", calls }
  }

  if (raw.msgType === "message" && raw.role === "user") {
    return {
      ...base(raw),
      kind: "prompt",
      body: collectText(raw.content),
      actor: actorFor(raw, agents),
    }
  }

  if (raw.msgType === "message") {
    return {
      ...base(raw),
      kind: "assistant",
      body: proseOf(raw.content),
      thinking: thinkingOf(raw.content),
      model: raw.model,
      actor: actorFor(raw, agents),
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

  for (const raw of payload.messages) {
    const record = toRecord(raw, callsByMessage, agents)
    if (record === null) continue

    if (belongsToBranch(raw, agents) && raw.agentId !== null) {
      const existing = branches.get(raw.agentId)
      if (existing) existing.push(record)
      else branches.set(raw.agentId, [record])
      continue
    }

    records.push(record)
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

export const artifactsOf = (records: ReadonlyArray<TimelineRecord>): ReadonlyArray<Artifact> =>
  records.flatMap((record) => (record.kind === "artifact" ? [record.artifact] : []))
