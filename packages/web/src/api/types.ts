export type ProjectSummary = {
  readonly id: string
  readonly name: string
  readonly slug: string
  readonly sessionCount: number
  readonly lastActiveAt: string | null
  readonly lastSessionTitle: string | null
}

export type SessionSummary = {
  readonly id: string
  readonly title: string | null
  readonly projectName: string
  readonly projectSlug: string
  readonly userLogin: string
  readonly model: string | null
  readonly durationMs: number | null
  readonly tokensTotal: number
  readonly status: string
  readonly lastActiveAt: string
}

export type SessionFacts = {
  readonly id: string
  readonly title: string | null
  readonly projectName: string
  readonly projectSlug: string
  readonly userLogin: string
  readonly model: string | null
  readonly durationMs: number | null
  readonly messageCount: number
  readonly toolCallCount: number
  readonly subagentCount: number
  readonly lastActiveAt: string
}

export type RawMessage = {
  readonly id: string
  readonly msgType: string
  readonly subType: string | null
  readonly role: string | null
  readonly lineNumber: number
  readonly timestamp: string | null
  readonly agentId: string | null
  readonly isSubagent: boolean
  readonly model: string | null
  readonly content: unknown
  readonly details: unknown
}

export type RawToolCall = {
  readonly toolId: string
  readonly messageId: string
  readonly toolName: string
  readonly toolInput: unknown
  readonly result: unknown
  readonly status: string | null
}

export type RawSubagent = {
  readonly agentId: string
  readonly agentType: string | null
  readonly description: string | null
  readonly parentAgentId: string | null
}

export type TokenTotals = {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cachedTokens: number
  readonly thinkingTokens: number
}

export type SessionDetailPayload = {
  readonly session: SessionFacts
  readonly messages: ReadonlyArray<RawMessage>
  readonly toolCalls: ReadonlyArray<RawToolCall>
  readonly subagents: ReadonlyArray<RawSubagent>
  readonly tokenUsage: TokenTotals
}

export type CurrentUser = {
  readonly id: string
  readonly githubLogin: string
  readonly email: string | null
  readonly name: string | null
  readonly avatarUrl: string | null
}

export type ApiErrorKind = "unauthorized" | "notFound" | "network" | "server"

export type ApiError = {
  readonly kind: ApiErrorKind
  readonly message: string
}

export type ApiResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: ApiError }

export type PairingCode = {
  readonly code: string
}

export type LogoutAck = {
  readonly ok: true
}
