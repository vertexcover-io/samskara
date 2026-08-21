export type ProjectOwner = {
  readonly type: "user" | "org"
  readonly slug: string
}

export type ProjectSummary = {
  readonly id: string
  readonly name: string
  readonly slug: string
  readonly owner: ProjectOwner
  readonly sessionCount: number
  readonly lastActiveAt: string | null
}

/** `host` is `local` for a repo with no remote — there `owner` is its absolute root path. */
export type SessionRepo = {
  readonly host: string
  readonly owner: string
  readonly repoName: string
}

export type SearchSourceKind = "session" | "message" | "pullRequest" | "toolCall" | "toolResult"

export type SearchSnippetSegment = {
  readonly text: string
  readonly highlighted: boolean
}

export type SessionSearchMatch = {
  readonly sourceKind: SearchSourceKind
  readonly sourceRowId: string
  readonly snippet: ReadonlyArray<SearchSnippetSegment>
}

export type SessionSummary = {
  readonly id: string
  readonly title: string | null
  readonly projectId: string
  readonly projectName: string
  readonly projectSlug: string
  readonly userLogin: string
  readonly repo: SessionRepo | null
  readonly durationMs: number | null
  readonly tokensTotal: number
  readonly status: string
  readonly lastActiveAt: string
  /** Decorative search evidence. It is null outside keyword searches or when it could not be read safely. */
  readonly match?: SessionSearchMatch | null
}

export type FilterOption = {
  readonly value: string
  readonly label: string
}

export type RepositoryFilterOption = FilterOption & {
  readonly host: string
  readonly owner: string
  readonly repoName: string
}

export type SessionFilterOptions = {
  readonly projects: ReadonlyArray<FilterOption>
  readonly authors: ReadonlyArray<FilterOption>
  readonly repositories: ReadonlyArray<RepositoryFilterOption>
  /** Branch names are their exact, case-sensitive values and also their presentation labels. */
  readonly branches: ReadonlyArray<string>
}

export type SessionPagination = {
  readonly page: number
  readonly limit: number
  readonly total: number
  /** API currently serializes this as `pages`; it remains the total page count. */
  readonly totalPages: number
}

export type SessionListPayload = {
  readonly sessions: ReadonlyArray<SessionSummary>
  readonly pagination: SessionPagination
  readonly filterOptions: SessionFilterOptions
}

export type SessionFacts = {
  readonly id: string
  readonly title: string | null
  readonly projectId: string
  readonly projectName: string
  readonly projectSlug: string
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
  /** Stable API error code when the server supplied one. */
  readonly code: string | null
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
