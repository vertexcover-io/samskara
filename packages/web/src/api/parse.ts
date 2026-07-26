import type {
  CurrentUser,
  ProjectSummary,
  RawMessage,
  RawSubagent,
  RawToolCall,
  SessionDetailPayload,
  SessionFacts,
  SessionSummary,
  TokenTotals,
} from "./types.js"

type Fields = Readonly<Record<string, unknown>>

const asFields = (value: unknown): Fields | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? { ...value } : null

const str = (value: unknown): string | null => (typeof value === "string" ? value : null)

const nullableStr = (value: unknown): string | null | undefined => {
  if (value === null) return null
  return typeof value === "string" ? value : undefined
}

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null

export const parseCurrentUser = (body: unknown): CurrentUser | null => {
  const fields = asFields(body)
  if (!fields) return null

  const id = str(fields.id)
  const githubLogin = str(fields.githubLogin)
  if (id === null || githubLogin === null) return null

  const email = nullableStr(fields.email)
  const name = nullableStr(fields.name)
  const avatarUrl = nullableStr(fields.avatarUrl)
  if (email === undefined || name === undefined || avatarUrl === undefined) return null

  return { id, githubLogin, email, name, avatarUrl }
}

const parseProjectSummary = (value: unknown): ProjectSummary | null => {
  const fields = asFields(value)
  if (!fields) return null

  const id = str(fields.id)
  const name = str(fields.name)
  const slug = str(fields.slug)
  const sessionCount = num(fields.sessionCount)
  if (id === null || name === null || slug === null || sessionCount === null) return null

  const lastActiveAt = nullableStr(fields.lastActiveAt)
  const lastSessionTitle = nullableStr(fields.lastSessionTitle)
  if (lastActiveAt === undefined || lastSessionTitle === undefined) return null

  return { id, name, slug, sessionCount, lastActiveAt, lastSessionTitle }
}

export const parseProjectList = (body: unknown): ReadonlyArray<ProjectSummary> | null => {
  const fields = asFields(body)
  if (!fields || !Array.isArray(fields.projects)) return null

  const parsed = fields.projects.map(parseProjectSummary)
  return parsed.every((project): project is ProjectSummary => project !== null) ? parsed : null
}

const nullableNum = (value: unknown): number | null | undefined => {
  if (value === null) return null
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

const parseSessionSummary = (value: unknown): SessionSummary | null => {
  const fields = asFields(value)
  if (!fields) return null

  const id = str(fields.id)
  const projectName = str(fields.projectName)
  const projectSlug = str(fields.projectSlug)
  const userLogin = str(fields.userLogin)
  const status = str(fields.status)
  const lastActiveAt = str(fields.lastActiveAt)
  const tokensTotal = num(fields.tokensTotal)
  if (id === null || projectName === null || projectSlug === null) return null
  if (userLogin === null || status === null || lastActiveAt === null) return null
  if (tokensTotal === null) return null

  const title = nullableStr(fields.title)
  const model = nullableStr(fields.model)
  const durationMs = nullableNum(fields.durationMs)
  if (title === undefined || model === undefined || durationMs === undefined) return null

  return {
    id,
    title,
    projectName,
    projectSlug,
    userLogin,
    model,
    durationMs,
    tokensTotal,
    status,
    lastActiveAt,
  }
}

export const parseSessionList = (body: unknown): ReadonlyArray<SessionSummary> | null => {
  const fields = asFields(body)
  if (!fields || !Array.isArray(fields.sessions)) return null

  const parsed = fields.sessions.map(parseSessionSummary)
  return parsed.every((session): session is SessionSummary => session !== null) ? parsed : null
}

const bool = (value: unknown): boolean => value === true

const numOr = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback

const parseFacts = (value: unknown): SessionFacts | null => {
  const fields = asFields(value)
  if (!fields) return null

  const id = str(fields.id)
  const projectName = str(fields.projectName)
  const projectSlug = str(fields.projectSlug)
  const userLogin = str(fields.userLogin)
  const lastActiveAt = str(fields.lastActiveAt)
  if (id === null || projectName === null || projectSlug === null) return null
  if (userLogin === null || lastActiveAt === null) return null

  const title = nullableStr(fields.title)
  const model = nullableStr(fields.model)
  const durationMs = nullableNum(fields.durationMs)
  if (title === undefined || model === undefined || durationMs === undefined) return null

  return {
    id,
    title,
    projectName,
    projectSlug,
    userLogin,
    model,
    durationMs,
    messageCount: numOr(fields.messageCount, 0),
    toolCallCount: numOr(fields.toolCallCount, 0),
    subagentCount: numOr(fields.subagentCount, 0),
    lastActiveAt,
    createdAt: nullableStr(fields.createdAt) ?? null,
  }
}

const parseMessage = (value: unknown): RawMessage | null => {
  const fields = asFields(value)
  if (!fields) return null

  const id = str(fields.id)
  const msgType = str(fields.msgType)
  if (id === null || msgType === null) return null

  return {
    id,
    msgType,
    subType: nullableStr(fields.subType) ?? null,
    role: nullableStr(fields.role) ?? null,
    lineNumber: numOr(fields.lineNumber, 0),
    timestamp: nullableStr(fields.timestamp) ?? null,
    agentId: nullableStr(fields.agentId) ?? null,
    isSubagent: bool(fields.isSubagent),
    model: nullableStr(fields.model) ?? null,
    content: fields.content ?? null,
    details: fields.details ?? null,
  }
}

const parseToolCall = (value: unknown): RawToolCall | null => {
  const fields = asFields(value)
  if (!fields) return null

  const toolId = str(fields.toolId)
  const messageId = str(fields.messageId)
  const toolName = str(fields.toolName)
  if (toolId === null || messageId === null || toolName === null) return null

  return {
    toolId,
    messageId,
    toolName,
    toolInput: fields.toolInput ?? null,
    result: fields.result ?? null,
    status: nullableStr(fields.status) ?? null,
  }
}

const parseSubagent = (value: unknown): RawSubagent | null => {
  const fields = asFields(value)
  if (!fields) return null

  const agentId = str(fields.agentId)
  if (agentId === null) return null

  return {
    agentId,
    agentType: nullableStr(fields.agentType) ?? null,
    description: nullableStr(fields.description) ?? null,
    parentAgentId: nullableStr(fields.parentAgentId) ?? null,
  }
}

const parseTokens = (value: unknown): TokenTotals => {
  const fields = asFields(value) ?? {}
  return {
    inputTokens: numOr(fields.inputTokens, 0),
    outputTokens: numOr(fields.outputTokens, 0),
    cachedTokens: numOr(fields.cachedTokens, 0),
    thinkingTokens: numOr(fields.thinkingTokens, 0),
  }
}

const allParsed = <T>(values: ReadonlyArray<T | null>): ReadonlyArray<T> | null =>
  values.every((value): value is T => value !== null) ? values : null

export const parseSessionDetail = (body: unknown): SessionDetailPayload | null => {
  const fields = asFields(body)
  if (!fields) return null
  if (!Array.isArray(fields.messages)) return null
  if (!Array.isArray(fields.toolCalls) || !Array.isArray(fields.subagents)) return null

  const session = parseFacts(fields.session)
  const messages = allParsed(fields.messages.map(parseMessage))
  const toolCalls = allParsed(fields.toolCalls.map(parseToolCall))
  const subagents = allParsed(fields.subagents.map(parseSubagent))
  if (session === null || messages === null || toolCalls === null || subagents === null) return null

  return { session, messages, toolCalls, subagents, tokenUsage: parseTokens(fields.tokenUsage) }
}
