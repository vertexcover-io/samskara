import type { SessionRepo } from "./shapes.js"

export type SessionFacts = {
  readonly id: string
  readonly title: string | null
  readonly projectId: string
  readonly projectName: string
  readonly userLogin: string
  readonly repo: SessionRepo | null
  readonly durationMs: number | null
  readonly messageCount: number
  readonly toolCallCount: number
  readonly subagentCount: number
  readonly lastActiveAt: string
  readonly createdAt: string | null
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
  /** The `Agent`/`Task` call that launched it. Null when a human started it, so no call exists. */
  readonly spawnToolUseId: string | null
}

export type TokenTotals = {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cachedTokens: number
  readonly thinkingTokens: number
}

/**
 * `recordedAt` is when capture filed the commit, not its author date. `messageId` names the turn
 * that produced it, which is what lets a sha link back to the moment it was made.
 */
export type SessionCommit = {
  readonly sha: string
  readonly branch: string | null
  readonly subject: string | null
  readonly filesChanged: number | null
  readonly insertions: number | null
  readonly deletions: number | null
  readonly messageId: string | null
  readonly recordedAt: string
  readonly repo: SessionRepo
}

/** Capture stores only PRs the session opened, so every row here was created by this session. */
export type SessionPullRequest = {
  readonly number: number
  readonly title: string | null
  readonly baseBranch: string | null
  readonly headBranch: string | null
  readonly messageId: string | null
  readonly recordedAt: string
  readonly repo: SessionRepo
}

export type SessionDetailPayload = {
  readonly session: SessionFacts
  readonly messages: ReadonlyArray<RawMessage>
  readonly toolCalls: ReadonlyArray<RawToolCall>
  readonly subagents: ReadonlyArray<RawSubagent>
  readonly tokenUsage: TokenTotals
  readonly commits: ReadonlyArray<SessionCommit>
  readonly pullRequests: ReadonlyArray<SessionPullRequest>
}

/**
 * A file the daemon captured during a session. Distinct from `session/records.ts — Artifact`,
 * which models a `frame-link` the agent surfaced mid-transcript: that one has a url and an
 * access flag, this one has a base, a diff, and an edit count.
 */
export type CapturedArtifact = {
  readonly id: string
  readonly path: string
  readonly relativePath: string
  readonly mimeType: string
  readonly isBinary: boolean
  readonly changeKind: string
  readonly diff: string | null
  readonly oldFragment: string | null
  readonly editCount: number
  readonly firstSeenAt: string
  readonly lastSeenAt: string
}
