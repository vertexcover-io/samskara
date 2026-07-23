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

// Line-level fields (lineUuid, lineNumber) live on the ParsedRecord; a message keeps subIndex.
export type NormalizedMessage = {
  readonly subIndex: number
  readonly sessionId: string
  readonly source: string
  readonly sourceSchemaVersion: number
  readonly msgType: MsgType
  readonly timestamp: string
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

// One source line with its own fan-out; raw is shared by the line's messages.
export type ParsedRecord = {
  readonly lineUuid: string
  readonly lineNumber: number
  readonly raw: string
  readonly messages: ReadonlyArray<NormalizedMessage>
}

export type AgentInfo = {
  readonly agentId: string
  readonly agentType?: string
  readonly description?: string
  readonly spawnDepth?: number
  readonly spawnToolUseId?: string
}

export type IngestBase = {
  readonly sessionId: string
  readonly project: ProjectIdentity
  readonly sourceRelativePath: string
  readonly title?: string
  readonly records: ReadonlyArray<ParsedRecord>
}

export type IngestPayload =
  | (IngestBase & { readonly type: "main" })
  | (IngestBase & { readonly type: "subagent"; readonly agent: AgentInfo })

export type IngestResponse =
  | { readonly ingested: number; readonly deduped: number }
  | { readonly error: "sessionNotFound" }
  | { readonly error: "unauthorized" }
