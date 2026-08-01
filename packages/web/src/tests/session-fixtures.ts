import type {
  RawMessage,
  RawSubagent,
  RawToolCall,
  SessionDetailPayload,
  SessionFacts,
  TokenTotals,
} from "../api/types.js"

let counter = 0

export const message = (overrides: Partial<RawMessage> = {}): RawMessage => {
  counter += 1
  return {
    id: `m-${counter}`,
    msgType: "message",
    subType: null,
    role: null,
    lineNumber: counter,
    timestamp: "2026-03-01T10:00:00.000Z",
    agentId: null,
    isSubagent: false,
    model: null,
    content: null,
    details: null,
    ...overrides,
  }
}

export const facts = (overrides: Partial<SessionFacts> = {}): SessionFacts => ({
  id: "s-1",
  title: "Make ingest idempotent",
  projectName: "Samskara",
  projectSlug: "samskara",
  userLogin: "ritesh",
  repo: null,
  durationMs: 1_451_000,
  messageCount: 0,
  toolCallCount: 0,
  subagentCount: 0,
  lastActiveAt: "2026-03-01T12:00:00.000Z",
  createdAt: "2026-03-01T10:00:00.000Z",
  ...overrides,
})

export const tokens = (overrides: Partial<TokenTotals> = {}): TokenTotals => ({
  inputTokens: 214_600,
  outputTokens: 18_200,
  cachedTokens: 0,
  thinkingTokens: 0,
  ...overrides,
})

type PayloadParts = {
  readonly session?: Partial<SessionFacts>
  readonly messages?: ReadonlyArray<RawMessage>
  readonly toolCalls?: ReadonlyArray<RawToolCall>
  readonly subagents?: ReadonlyArray<RawSubagent>
  readonly tokenUsage?: Partial<TokenTotals>
}

export const buildPayload = (parts: PayloadParts = {}): SessionDetailPayload => {
  const messages = parts.messages ?? []
  const toolCalls = parts.toolCalls ?? []
  const subagents = parts.subagents ?? []
  return {
    session: facts({
      messageCount: messages.length,
      toolCallCount: toolCalls.length,
      subagentCount: subagents.length,
      ...parts.session,
    }),
    messages,
    toolCalls,
    subagents,
    tokenUsage: tokens(parts.tokenUsage),
  }
}

export const text = (value: string): unknown => ({ text: value })

export const pastedImage = (value: string, mediaType = "image/png"): unknown => ({
  type: "image",
  value,
  mediaType,
  encoding: "base64",
})
