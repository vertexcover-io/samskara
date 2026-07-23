export const MSG_TYPES = [
  "user",
  "assistant",
  "system",
  "toolCall",
  "toolResult",
  "progress",
  "systemEvent",
  "queueOperation",
  "fileSnapshot",
  "summary",
] as const

export type MsgType = (typeof MSG_TYPES)[number]

export type RepoIdentity = {
  readonly host: string
  readonly owner: string
  readonly ownerType: "user" | "org"
  readonly repoName: string
}

export type ProjectIdentity = {
  readonly name: string // git repo name, or cwd basename
  readonly slug: string // "<owner>-<reponame>", or cwd with separators → "-"
  // NOTE: no ownerId — the server derives it from the JWT user
}

export type TokenUsage = {
  readonly input: number
  readonly output: number
  readonly cached: number
  readonly thinking: number
}

export type ToolCall = {
  readonly id: string
  readonly name: string
  readonly input: unknown
}

export type ToolResult = {
  readonly callId: string
  readonly output: string
  readonly status: "success" | "failure"
}

export type NormalizedMessage = {
  readonly lineUuid: string
  readonly subIndex: number
  readonly sessionId: string
  readonly source: string
  readonly sourceSchemaVersion: number
  readonly msgType: MsgType
  readonly timestamp: string
  readonly lineNumber: number
  readonly content?: string
  readonly thinking?: string
  readonly model?: string
  readonly provider?: string
  readonly role?: string
  readonly parentUuid?: string
  readonly tokens?: TokenUsage
  readonly toolCall?: ToolCall
  readonly toolResult?: ToolResult
  readonly agentId?: string
  readonly gitBranch?: string
  readonly gitCommit?: string
}

export type RawLine = {
  readonly lineUuid: string
  readonly raw: string
}

export type AgentInfo = {
  readonly agentId: string
  readonly agentType?: string
  readonly description?: string
  readonly spawnDepth?: number
  readonly spawnToolUseId?: string
}

export type SessionFields = {
  readonly model?: string
  readonly title?: string
  readonly cwd?: string
  readonly cliVersion?: string
  readonly permissionMode?: string
}

export type IngestBase = {
  readonly sessionId: string
  readonly sourceRelativePath: string
  readonly project: ProjectIdentity
  readonly rawLines: ReadonlyArray<RawLine>
  readonly messages: ReadonlyArray<NormalizedMessage>
}

export type IngestPayload =
  | (IngestBase & { readonly type: "main"; readonly session: SessionFields })
  | (IngestBase & { readonly type: "subagent"; readonly agent: AgentInfo })

export type IngestResponse =
  | { readonly ingested: number; readonly deduped: number }
  | { readonly error: "sessionNotFound" }
  | { readonly error: "unauthorized" }
