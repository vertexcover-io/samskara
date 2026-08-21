import type {
  RawMessage,
  RawSubagent,
  RawToolCall,
  SessionCommit,
  SessionDetailPayload,
  SessionFacts,
  SessionPullRequest,
  TokenTotals,
} from "../api/shapes.js"

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
  projectId: "p-1",
  projectName: "Samskara",
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
  readonly commits?: ReadonlyArray<SessionCommit>
  readonly pullRequests?: ReadonlyArray<SessionPullRequest>
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
    // Spread into a fresh array: the server's inferred `commits`/`pullRequests` fields are
    // built with `.map(...)` and come back mutable, where `parts.commits` is `readonly`.
    commits: [...(parts.commits ?? [])],
    pullRequests: [...(parts.pullRequests ?? [])],
  }
}

const REPO = { host: "github.com", owner: "acme", repoName: "widgets" } as const

export const commit = (overrides: Partial<SessionCommit> = {}): SessionCommit => ({
  sha: "9f3c1ab",
  branch: "master",
  subject: "feat(ingest): make the upsert idempotent",
  filesChanged: 7,
  insertions: 152,
  deletions: 3,
  messageId: null,
  recordedAt: "2026-03-01T11:00:00.000Z",
  repo: REPO,
  ...overrides,
})

export const pullRequest = (overrides: Partial<SessionPullRequest> = {}): SessionPullRequest => ({
  number: 391,
  title: "Make ingest idempotent",
  baseBranch: "master",
  headBranch: "feat/idempotent-ingest",
  messageId: null,
  recordedAt: "2026-03-01T11:05:00.000Z",
  repo: REPO,
  ...overrides,
})

export const text = (value: string): unknown => ({ text: value })

export const pastedImage = (value: string, mediaType = "image/png"): unknown => ({
  type: "image",
  value,
  mediaType,
  encoding: "base64",
})
