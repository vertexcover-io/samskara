import { type SQL, and, asc, desc, eq, gte, lte, sql } from "drizzle-orm"
import type { PgColumn } from "drizzle-orm/pg-core"
import type { Querier } from "../db/client.js"
import {
  commits,
  messages,
  projects,
  pullRequests,
  repos,
  sessionPullRequests,
  sessions,
  subagents,
  tokenUsage,
  toolCall,
  toolResult,
  users,
} from "../db/schema.js"
import { visibleToUser } from "./projects.repo.js"

export type SessionFields = {
  readonly title?: string
  readonly startCwd?: string
  readonly startCommit?: string
}

export type UpsertSessionInput = {
  readonly id: string
  readonly source: string
  readonly userId: string
  readonly projectId: string
  readonly fields: SessionFields
}

/** Incoming non-null wins (`excluded` first): capture rarely supplies a title, the latest is best. */
const enrich = (column: PgColumn) =>
  sql`coalesce(${sql.raw(`excluded."${column.name}"`)}, ${column})`

/**
 * The launch context (`cwd`, `startCommit`) is written only on row creation and never on
 * conflict: a replayed transcript reads today's HEAD, not the sha the session started on, so a
 * re-stamp is always wrong. A session created without one keeps null forever.
 */
export const upsert = async (db: Querier, input: UpsertSessionInput): Promise<void> => {
  const { id, source, userId, projectId, fields } = input
  await db
    .insert(sessions)
    .values({
      id,
      source,
      userId,
      projectId,
      title: fields.title,
      cwd: fields.startCwd,
      startCommit: fields.startCommit,
    })
    .onConflictDoUpdate({
      target: sessions.id,
      set: {
        title: enrich(sessions.title),
        updatedAt: sql`now()`,
      },
    })
}

/**
 * Scoped to the caller: existence alone is not authorization. Used by write paths (artifact
 * upload) where any valid `aud:cli` token must not be able to attach data to another user's
 * session just by naming its id.
 */
export const existsForUser = async (db: Querier, id: string, userId: string): Promise<boolean> => {
  const [row] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.id, id), eq(sessions.userId, userId)))
  return row !== undefined
}

export type SessionRepo = {
  readonly host: string
  readonly owner: string
  readonly repoName: string
}

export type SessionSummaryRow = {
  readonly id: string
  readonly title: string | null
  readonly projectName: string
  readonly projectSlug: string
  readonly userLogin: string
  readonly repo: SessionRepo | null
  readonly durationMs: number | null
  readonly tokensTotal: number
  readonly status: string
  readonly lastActiveAt: string
}

export type SessionListFilter = {
  readonly projectSlug?: string
  readonly userLogin?: string
  readonly since?: Date
  readonly until?: Date
}

const ownMessages = sql`"messages" where "messages"."sessionId" = "sessions"."id"`

const messageCount = sql<number>`(select count(*)::int from ${ownMessages})`

const durationMs = sql<number | null>`(
  select (extract(epoch from max("messages"."timestamp") - min("messages"."timestamp")) * 1000)::bigint
  from ${ownMessages}
  having count("messages"."timestamp") > 1
)`

/**
 * Every column is int4 and the total is not: a long session passes 2^31 on cached tokens alone.
 * Widening before the addition -- not after -- is what matters, since `a + b` overflows while
 * evaluating, long before any cast to the result could apply.
 */
const tokensTotal = sql<number>`(
  select coalesce(sum(
    "tokenUsage"."inputTokens"::bigint + "tokenUsage"."outputTokens"::bigint
    + "tokenUsage"."cachedTokens"::bigint + "tokenUsage"."thinkingTokens"::bigint
  ), 0)::bigint
  from "tokenUsage"
  join "messages" on "messages"."id" = "tokenUsage"."messageId"
  where "messages"."sessionId" = "sessions"."id"
)`

const status = sql<string>`case when ${messageCount} = 0 then 'empty' else 'complete' end`

/**
 * A session has no repo of its own: attribution lives on messages, and one session can span a
 * workspace's sub-repos. The repo most of its messages ran in stands for the session, ties going
 * to whichever appeared first.
 */
const dominantRepoId = sql`(
  select "messages"."repoId"
  from ${ownMessages} and "messages"."repoId" is not null
  group by "messages"."repoId"
  order by count(*) desc, min("messages"."lineNumber") asc
  limit 1
)`

const repoColumns = {
  repoHost: repos.host,
  repoOwner: repos.owner,
  repoName: repos.repoName,
}

type RepoColumns = {
  readonly repoHost: string | null
  readonly repoOwner: string | null
  readonly repoName: string | null
}

const withRepo = <T extends RepoColumns>({
  repoHost,
  repoOwner,
  repoName,
  ...rest
}: T): Omit<T, keyof RepoColumns> & { readonly repo: SessionRepo | null } => ({
  ...rest,
  repo:
    repoHost !== null && repoOwner !== null && repoName !== null
      ? { host: repoHost, owner: repoOwner, repoName }
      : null,
})

// Capture rarely supplies a title, so fall back to the opening user prompt.
const derivedTitle = sql<string | null>`coalesce(${sessions.title}, (
  select left(
    btrim(split_part(
      coalesce(m."content"->>'value', m."content"->>'text', m."content"->>'body'),
      chr(10), 1
    )),
    120
  )
  from "messages" m
  where m."sessionId" = ${sessions.id}
    and m."msgType" = 'message'
    and m."role" = 'user'
    and coalesce(m."content"->>'value', m."content"->>'text', m."content"->>'body') is not null
    and btrim(coalesce(m."content"->>'value', m."content"->>'text', m."content"->>'body')) <> ''
  order by m."lineNumber" asc
  limit 1
))`

export const listAccessible = (
  db: Querier,
  userId: string,
  filter: SessionListFilter = {},
): Promise<ReadonlyArray<SessionSummaryRow>> => {
  const conditions: Array<SQL | undefined> = [visibleToUser(db, userId)]
  if (filter.projectSlug !== undefined) conditions.push(eq(projects.slug, filter.projectSlug))
  if (filter.userLogin !== undefined) conditions.push(eq(users.githubLogin, filter.userLogin))
  if (filter.since !== undefined) conditions.push(gte(sessions.updatedAt, filter.since))
  if (filter.until !== undefined) conditions.push(lte(sessions.updatedAt, filter.until))

  return db
    .select({
      id: sessions.id,
      title: derivedTitle,
      projectName: projects.name,
      projectSlug: projects.slug,
      userLogin: users.githubLogin,
      ...repoColumns,
      durationMs,
      tokensTotal,
      status,
      lastActiveAt: sql<string>`${sessions.updatedAt}`,
    })
    .from(sessions)
    .innerJoin(projects, eq(projects.id, sessions.projectId))
    .innerJoin(users, eq(users.id, sessions.userId))
    .leftJoin(repos, sql`${repos.id} = ${dominantRepoId}`)
    .where(and(...conditions))
    .orderBy(desc(sessions.updatedAt))
    .then((rows) => rows.map((row) => ({ ...withRepo(row), tokensTotal: Number(row.tokensTotal) })))
}

export const findVisibleProjectBySlug = async (
  db: Querier,
  userId: string,
  slug: string,
): Promise<string | null> => {
  const [row] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.slug, slug), visibleToUser(db, userId)))
  return row?.id ?? null
}

export type SessionFactsRow = {
  readonly id: string
  readonly title: string | null
  readonly projectName: string
  readonly projectSlug: string
  readonly userLogin: string
  readonly repo: SessionRepo | null
  readonly durationMs: number | null
  readonly messageCount: number
  readonly toolCallCount: number
  readonly subagentCount: number
  readonly lastActiveAt: string
  readonly createdAt: string
}

export type MessageRow = {
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

export type ToolCallRow = {
  readonly toolId: string
  readonly messageId: string
  readonly toolName: string
  readonly toolInput: unknown
  readonly result: unknown
  readonly status: string | null
}

export type SubagentRow = {
  readonly agentId: string
  readonly agentType: string | null
  readonly description: string | null
  readonly parentAgentId: string | null
  readonly spawnToolUseId: string | null
}

export type TokenUsageTotals = {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cachedTokens: number
  readonly thinkingTokens: number
}

/**
 * `recordedAt` is when capture filed the commit, not the author date -- the transcript is the
 * clock here. `messageId` is the turn that produced it, which is what ties a commit to the
 * moment it was made rather than leaving it a free-floating sha.
 */
export type SessionCommitRow = {
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

/** A row exists only for a PR the session opened, so membership already means "created here". */
export type SessionPullRequestRow = {
  readonly number: number
  readonly title: string | null
  readonly baseBranch: string | null
  readonly headBranch: string | null
  readonly messageId: string | null
  readonly recordedAt: string
  readonly repo: SessionRepo
}

export type SessionDetailRow = {
  readonly session: SessionFactsRow
  readonly messages: ReadonlyArray<MessageRow>
  readonly toolCalls: ReadonlyArray<ToolCallRow>
  readonly subagents: ReadonlyArray<SubagentRow>
  readonly tokenUsage: TokenUsageTotals
  readonly commits: ReadonlyArray<SessionCommitRow>
  readonly pullRequests: ReadonlyArray<SessionPullRequestRow>
}

const toolCallCount = sql<number>`(
  select count(*)::int from "toolCall"
  join "messages" on "messages"."id" = "toolCall"."messageId"
  where "messages"."sessionId" = "sessions"."id"
)`

const subagentCount = sql<number>`(
  select count(*)::int from "subagents"
  where "subagents"."sessionId" = "sessions"."id"
)`

const findVisibleSession = async (
  db: Querier,
  userId: string,
  sessionId: string,
): Promise<SessionFactsRow | undefined> => {
  const [row] = await db
    .select({
      id: sessions.id,
      title: derivedTitle,
      projectName: projects.name,
      projectSlug: projects.slug,
      userLogin: users.githubLogin,
      ...repoColumns,
      durationMs,
      messageCount,
      toolCallCount,
      subagentCount,
      lastActiveAt: sql<string>`${sessions.updatedAt}`,
      createdAt: sql<string>`${sessions.createdAt}`,
    })
    .from(sessions)
    .innerJoin(projects, eq(projects.id, sessions.projectId))
    .innerJoin(users, eq(users.id, sessions.userId))
    .leftJoin(repos, sql`${repos.id} = ${dominantRepoId}`)
    .where(and(eq(sessions.id, sessionId), visibleToUser(db, userId)))
  return row === undefined ? undefined : withRepo(row)
}

const EMPTY_TOKENS: TokenUsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  thinkingTokens: 0,
}

/**
 * The driver hands back `bigint` as a string, so a column widened to survive the sum arrives as
 * text and would serialise as `"7000000000"`. Converting here keeps the row's declared `number`
 * type honest rather than leaving each route to remember a cast. Exact well past any real total:
 * doubles carry integers to 2^53.
 */
const countedTokens = (row: TokenUsageTotals | undefined): TokenUsageTotals =>
  row === undefined
    ? EMPTY_TOKENS
    : {
        inputTokens: Number(row.inputTokens),
        outputTokens: Number(row.outputTokens),
        cachedTokens: Number(row.cachedTokens),
        thinkingTokens: Number(row.thinkingTokens),
      }

export const getDetail = async (
  db: Querier,
  userId: string,
  sessionId: string,
): Promise<SessionDetailRow | null> => {
  const facts = await findVisibleSession(db, userId, sessionId)
  if (!facts) return null

  const [messageRows, toolCallRows, subagentRows, tokenRows, commitRows, prRows] =
    await Promise.all([
      db
        .select({
          id: messages.id,
          msgType: messages.msgType,
          subType: messages.subType,
          role: messages.role,
          lineNumber: messages.lineNumber,
          timestamp: sql<string | null>`${messages.timestamp}`,
          agentId: messages.agentId,
          isSubagent: messages.isSubagent,
          model: messages.model,
          content: messages.content,
          details: messages.details,
        })
        .from(messages)
        .where(eq(messages.sessionId, sessionId))
        .orderBy(asc(messages.lineNumber), asc(messages.subIndex)),
      db
        .select({
          toolId: toolCall.toolId,
          messageId: toolCall.messageId,
          toolName: toolCall.toolName,
          toolInput: toolCall.toolInput,
          result: toolResult.result,
          status: toolResult.status,
        })
        .from(toolCall)
        .innerJoin(messages, eq(messages.id, toolCall.messageId))
        .leftJoin(toolResult, eq(toolResult.toolId, toolCall.toolId))
        .where(eq(messages.sessionId, sessionId))
        .orderBy(asc(messages.lineNumber), asc(toolCall.toolId)),
      db
        .select({
          agentId: subagents.agentId,
          agentType: subagents.agentType,
          description: subagents.description,
          parentAgentId: subagents.parentAgentId,
          spawnToolUseId: subagents.spawnToolUseId,
        })
        .from(subagents)
        .where(eq(subagents.sessionId, sessionId))
        .orderBy(asc(subagents.createdAt), asc(subagents.agentId)),
      db
        .select({
          // `sum()` over int4 is already bigint; casting it back to int is what overflowed.
          inputTokens: sql<number>`coalesce(sum(${tokenUsage.inputTokens}), 0)::bigint`,
          outputTokens: sql<number>`coalesce(sum(${tokenUsage.outputTokens}), 0)::bigint`,
          cachedTokens: sql<number>`coalesce(sum(${tokenUsage.cachedTokens}), 0)::bigint`,
          thinkingTokens: sql<number>`coalesce(sum(${tokenUsage.thinkingTokens}), 0)::bigint`,
        })
        .from(tokenUsage)
        .innerJoin(messages, eq(messages.id, tokenUsage.messageId))
        .where(eq(messages.sessionId, sessionId)),
      db
        .select({
          sha: commits.sha,
          branch: commits.branch,
          subject: commits.subject,
          filesChanged: commits.filesChanged,
          insertions: commits.insertions,
          deletions: commits.deletions,
          messageId: commits.messageId,
          recordedAt: sql<string>`${commits.createdAt}`,
          repoHost: repos.host,
          repoOwner: repos.owner,
          repoName: repos.repoName,
        })
        .from(commits)
        .innerJoin(repos, eq(repos.id, commits.repoId))
        .where(eq(commits.sessionId, sessionId))
        .orderBy(asc(commits.createdAt), asc(commits.sha)),
      db
        .select({
          number: pullRequests.number,
          title: pullRequests.title,
          baseBranch: pullRequests.baseBranch,
          headBranch: pullRequests.headBranch,
          messageId: sessionPullRequests.messageId,
          recordedAt: sql<string>`${sessionPullRequests.createdAt}`,
          repoHost: repos.host,
          repoOwner: repos.owner,
          repoName: repos.repoName,
        })
        .from(sessionPullRequests)
        .innerJoin(pullRequests, eq(pullRequests.id, sessionPullRequests.prId))
        .innerJoin(repos, eq(repos.id, pullRequests.repoId))
        .where(eq(sessionPullRequests.sessionId, sessionId))
        .orderBy(asc(pullRequests.number)),
    ])

  return {
    session: facts,
    messages: messageRows,
    toolCalls: toolCallRows,
    subagents: subagentRows,
    tokenUsage: countedTokens(tokenRows[0]),
    commits: commitRows.map(({ repoHost, repoOwner, repoName, ...commit }) => ({
      ...commit,
      repo: { host: repoHost, owner: repoOwner, repoName },
    })),
    pullRequests: prRows.map(({ repoHost, repoOwner, repoName, ...pr }) => ({
      ...pr,
      repo: { host: repoHost, owner: repoOwner, repoName },
    })),
  }
}
