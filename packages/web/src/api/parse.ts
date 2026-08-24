import type {
  CapturedArtifact,
  CurrentUser,
  ProjectOwner,
  ProjectSummary,
  RawMessage,
  RawSubagent,
  RawToolCall,
  SessionCommit,
  SessionDetailPayload,
  SessionFacts,
  SessionFilterOptions,
  SessionListPayload,
  SessionPagination,
  SessionPullRequest,
  SessionRepo,
  SessionSearchMatch,
  SessionSummary,
  SyncStatusRow,
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

const parseProjectOwner = (value: unknown): ProjectOwner | null => {
  const fields = asFields(value)
  if (!fields) return null

  const type = str(fields.type)
  const slug = str(fields.slug)
  if (type !== "user" && type !== "org") return null
  if (slug === null) return null

  return { type, slug }
}

const parseProjectSummary = (value: unknown): ProjectSummary | null => {
  const fields = asFields(value)
  if (!fields) return null

  const id = str(fields.id)
  const name = str(fields.name)
  const slug = str(fields.slug)
  const sessionCount = num(fields.sessionCount)
  const owner = parseProjectOwner(fields.owner)
  if (id === null || name === null || slug === null || sessionCount === null || owner === null)
    return null

  const lastActiveAt = nullableStr(fields.lastActiveAt)
  if (lastActiveAt === undefined) return null

  return { id, name, slug, owner, sessionCount, lastActiveAt }
}

export const parseProjectList = (body: unknown): ReadonlyArray<ProjectSummary> | null => {
  const fields = asFields(body)
  if (!fields || !Array.isArray(fields.projects)) return null

  const parsed = fields.projects.map(parseProjectSummary)
  return parsed.every((project): project is ProjectSummary => project !== null) ? parsed : null
}

const parseSyncStatusRow = (value: unknown): SyncStatusRow | null => {
  const fields = asFields(value)
  if (!fields) return null

  const userId = str(fields.userId)
  const githubLogin = str(fields.githubLogin)
  const sessionCount = num(fields.sessionCount)
  if (userId === null || githubLogin === null || sessionCount === null) return null

  const name = nullableStr(fields.name)
  const avatarUrl = nullableStr(fields.avatarUrl)
  const projectId = nullableStr(fields.projectId)
  const projectName = nullableStr(fields.projectName)
  const projectSlug = nullableStr(fields.projectSlug)
  const lastSyncedAt = nullableStr(fields.lastSyncedAt)
  if (
    name === undefined ||
    avatarUrl === undefined ||
    projectId === undefined ||
    projectName === undefined ||
    projectSlug === undefined ||
    lastSyncedAt === undefined
  ) {
    return null
  }

  return {
    userId,
    githubLogin,
    name,
    avatarUrl,
    projectId,
    projectName,
    projectSlug,
    sessionCount,
    lastSyncedAt,
  }
}

export const parseSyncStatusRows = (body: unknown): ReadonlyArray<SyncStatusRow> | null => {
  const fields = asFields(body)
  if (!fields || !Array.isArray(fields.rows)) return null

  const parsed = fields.rows.map(parseSyncStatusRow)
  return parsed.every((row): row is SyncStatusRow => row !== null) ? parsed : null
}

const nullableNum = (value: unknown): number | null | undefined => {
  if (value === null) return null
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/** Lenient by design: the repo decorates a session, so a malformed one is dropped, not fatal. */
const parseRepo = (value: unknown): SessionRepo | null => {
  const fields = asFields(value)
  if (!fields) return null

  const host = str(fields.host)
  const owner = str(fields.owner)
  const repoName = str(fields.repoName)
  if (host === null || owner === null || repoName === null) return null

  return { host, owner, repoName }
}

const parseSessionSummary = (value: unknown): SessionSummary | null => {
  const fields = asFields(value)
  if (!fields) return null

  const id = str(fields.id)
  const projectId = str(fields.projectId)
  const projectName = str(fields.projectName)
  const userLogin = str(fields.userLogin)
  const status = str(fields.status)
  const lastActiveAt = str(fields.lastActiveAt)
  const tokensTotal = num(fields.tokensTotal)
  if (id === null || projectId === null || projectName === null) return null
  if (userLogin === null || status === null || lastActiveAt === null) return null
  if (tokensTotal === null) return null

  const title = nullableStr(fields.title)
  const durationMs = nullableNum(fields.durationMs)
  if (title === undefined || durationMs === undefined) return null

  return {
    id,
    title,
    projectId,
    projectName,
    userLogin,
    repo: parseRepo(fields.repo),
    durationMs,
    tokensTotal,
    status,
    lastActiveAt,
    match: parseSearchMatch(fields.match),
  }
}

const SEARCH_SOURCE_KINDS = new Set(["session", "message", "pullRequest", "toolCall", "toolResult"])
const MAX_SNIPPET_SEGMENTS = 32
const MAX_SNIPPET_CHARS = 4_000

/** Search evidence is decorative: reject malformed evidence but keep the trustworthy session row. */
const parseSearchMatch = (value: unknown): SessionSearchMatch | null => {
  if (value === null || value === undefined) return null
  const fields = asFields(value)
  if (!fields) return null

  const sourceKind = str(fields.sourceKind)
  const sourceRowId = str(fields.sourceRowId)
  if (sourceKind === null || !SEARCH_SOURCE_KINDS.has(sourceKind) || sourceRowId === null)
    return null
  if (!Array.isArray(fields.snippet) || fields.snippet.length > MAX_SNIPPET_SEGMENTS) return null

  let length = 0
  const snippet = fields.snippet.map((segment) => {
    const part = asFields(segment)
    const text = part === null ? null : str(part.text)
    if (text === null || part === null || typeof part.highlighted !== "boolean") return null
    length += text.length
    return { text, highlighted: part.highlighted }
  })
  if (
    length > MAX_SNIPPET_CHARS ||
    !snippet.every((segment): segment is NonNullable<typeof segment> => segment !== null)
  ) {
    return null
  }

  return { sourceKind: sourceKind as SessionSearchMatch["sourceKind"], sourceRowId, snippet }
}

const parseOption = (value: unknown): { readonly value: string; readonly label: string } | null => {
  const fields = asFields(value)
  if (!fields) return null
  const valueText = str(fields.value)
  const label = str(fields.label)
  return valueText === null || label === null ? null : { value: valueText, label }
}

const parseOptions = (
  value: unknown,
): ReadonlyArray<{ readonly value: string; readonly label: string }> | null => {
  if (!Array.isArray(value)) return null
  const options = value.map(parseOption)
  return options.every((option): option is NonNullable<typeof option> => option !== null)
    ? options
    : null
}

const parseFilterOptions = (value: unknown): SessionFilterOptions | null => {
  const fields = asFields(value)
  if (!fields) return null
  const projects = parseOptions(fields.projects)
  const authors = parseOptions(fields.authors)
  const branches = fields.branches
  if (
    projects === null ||
    authors === null ||
    !Array.isArray(branches) ||
    !branches.every((branch): branch is string => typeof branch === "string") ||
    !Array.isArray(fields.repositories)
  )
    return null

  const repositories = fields.repositories.map((repository) => {
    const option = parseOption(repository)
    const repositoryFields = asFields(repository)
    const host = repositoryFields === null ? null : str(repositoryFields.host)
    const owner = repositoryFields === null ? null : str(repositoryFields.owner)
    const repoName = repositoryFields === null ? null : str(repositoryFields.repoName)
    return option === null || host === null || owner === null || repoName === null
      ? null
      : { ...option, host, owner, repoName }
  })
  if (
    !repositories.every(
      (repository): repository is NonNullable<typeof repository> => repository !== null,
    )
  ) {
    return null
  }
  return { projects, authors, repositories, branches }
}

const parsePagination = (value: unknown, sessionCount: number): SessionPagination | null => {
  const fields = asFields(value)
  if (!fields) return null
  const page = num(fields.page)
  const limit = num(fields.limit)
  const total = num(fields.total)
  const totalPages = num(fields.totalPages ?? fields.pages)
  if (
    page === null ||
    limit === null ||
    total === null ||
    totalPages === null ||
    !Number.isInteger(page) ||
    !Number.isInteger(limit) ||
    !Number.isInteger(total) ||
    !Number.isInteger(totalPages) ||
    page < 1 ||
    limit < 1 ||
    total < 0 ||
    totalPages < 0 ||
    totalPages !== Math.ceil(total / limit) ||
    sessionCount > limit ||
    // The server truthfully returns empty rows for a page beyond the final page.
    (totalPages === 0 && page !== 1) ||
    (sessionCount > 0 && page > totalPages)
  ) {
    return null
  }
  return { page, limit, total, totalPages }
}

export const parseSessionList = (body: unknown): SessionListPayload | null => {
  const fields = asFields(body)
  if (!fields || !Array.isArray(fields.sessions)) return null
  const sessions = fields.sessions.map(parseSessionSummary)
  if (!sessions.every((session): session is SessionSummary => session !== null)) return null
  const pagination = parsePagination(fields.pagination, sessions.length)
  const filterOptions = parseFilterOptions(fields.filterOptions)
  return pagination === null || filterOptions === null
    ? null
    : { sessions, pagination, filterOptions }
}

const bool = (value: unknown): boolean => value === true

const numOr = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback

const parseFacts = (value: unknown): SessionFacts | null => {
  const fields = asFields(value)
  if (!fields) return null

  const id = str(fields.id)
  const projectId = str(fields.projectId)
  const projectName = str(fields.projectName)
  const userLogin = str(fields.userLogin)
  const lastActiveAt = str(fields.lastActiveAt)
  if (id === null || projectId === null || projectName === null) return null
  if (userLogin === null || lastActiveAt === null) return null

  const title = nullableStr(fields.title)
  const durationMs = nullableNum(fields.durationMs)
  if (title === undefined || durationMs === undefined) return null

  return {
    id,
    title,
    projectId,
    projectName,
    userLogin,
    repo: parseRepo(fields.repo),
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
    spawnToolUseId: nullableStr(fields.spawnToolUseId) ?? null,
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

  return {
    session,
    messages,
    toolCalls,
    subagents,
    tokenUsage: parseTokens(fields.tokenUsage),
    commits: parseList(fields.commits, parseCommit),
    pullRequests: parseList(fields.pullRequests, parsePullRequest),
  }
}

/** Lenient like the repo it decorates: one malformed row is dropped, it does not fail the session. */
const parseList = <T>(value: unknown, parse: (row: unknown) => T | null): ReadonlyArray<T> => {
  if (!Array.isArray(value)) return []
  return value.flatMap((row) => {
    const parsed = parse(row)
    return parsed === null ? [] : [parsed]
  })
}

const parseCommit = (value: unknown): SessionCommit | null => {
  const fields = asFields(value)
  if (!fields) return null

  const sha = str(fields.sha)
  const recordedAt = str(fields.recordedAt)
  const repo = parseRepo(fields.repo)
  if (sha === null || recordedAt === null || repo === null) return null

  return {
    sha,
    branch: nullableStr(fields.branch) ?? null,
    subject: nullableStr(fields.subject) ?? null,
    filesChanged: nullableNum(fields.filesChanged) ?? null,
    insertions: nullableNum(fields.insertions) ?? null,
    deletions: nullableNum(fields.deletions) ?? null,
    messageId: nullableStr(fields.messageId) ?? null,
    recordedAt,
    repo,
  }
}

const parsePullRequest = (value: unknown): SessionPullRequest | null => {
  const fields = asFields(value)
  if (!fields) return null

  const number = num(fields.number)
  const recordedAt = str(fields.recordedAt)
  const repo = parseRepo(fields.repo)
  if (number === null || recordedAt === null || repo === null) return null

  return {
    number,
    title: nullableStr(fields.title) ?? null,
    baseBranch: nullableStr(fields.baseBranch) ?? null,
    headBranch: nullableStr(fields.headBranch) ?? null,
    messageId: nullableStr(fields.messageId) ?? null,
    recordedAt,
    repo,
  }
}

const parseCapturedArtifact = (value: unknown): CapturedArtifact | null => {
  const fields = asFields(value)
  if (!fields) return null

  const id = str(fields.id)
  const path = str(fields.path)
  const relativePath = str(fields.relativePath)
  const mimeType = str(fields.mimeType)
  const changeKind = str(fields.changeKind)
  const firstSeenAt = str(fields.firstSeenAt)
  const lastSeenAt = str(fields.lastSeenAt)
  if (id === null || path === null || relativePath === null || mimeType === null) return null
  if (changeKind === null || firstSeenAt === null || lastSeenAt === null) return null

  return {
    id,
    path,
    relativePath,
    mimeType,
    isBinary: bool(fields.isBinary),
    changeKind,
    // The list route omits both; the detail route supplies them.
    diff: nullableStr(fields.diff) ?? null,
    oldFragment: nullableStr(fields.oldFragment) ?? null,
    editCount: numOr(fields.editCount, 0),
    firstSeenAt,
    lastSeenAt,
  }
}

export const parseSessionArtifacts = (body: unknown): ReadonlyArray<CapturedArtifact> | null => {
  const fields = asFields(body)
  if (!fields || !Array.isArray(fields.artifacts)) return null

  return allParsed(fields.artifacts.map(parseCapturedArtifact))
}
