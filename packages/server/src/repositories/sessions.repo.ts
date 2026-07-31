import { type SQL, and, asc, desc, eq, gte, lte, sql } from "drizzle-orm"
import type { PgColumn } from "drizzle-orm/pg-core"
import type { Querier } from "../db/client.js"
import {
  messages,
  projects,
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
}

export type UpsertSessionInput = {
  readonly id: string
  readonly source: string
  readonly userId: string
  readonly projectId: string
  readonly fields: SessionFields
}

const keepExisting = (column: PgColumn) =>
  sql`coalesce(${sql.raw(`excluded."${column.name}"`)}, ${column})`

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
    })
    .onConflictDoUpdate({
      target: sessions.id,
      set: {
        title: keepExisting(sessions.title),
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

export type SessionSummaryRow = {
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

const tokensTotal = sql<number>`(
  select coalesce(sum(
    "tokenUsage"."inputTokens" + "tokenUsage"."outputTokens"
    + "tokenUsage"."cachedTokens" + "tokenUsage"."thinkingTokens"
  ), 0)::int
  from "tokenUsage"
  join "messages" on "messages"."id" = "tokenUsage"."messageId"
  where "messages"."sessionId" = "sessions"."id"
)`

const status = sql<string>`case when ${messageCount} = 0 then 'empty' else 'complete' end`

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
      model: sessions.model,
      durationMs,
      tokensTotal,
      status,
      lastActiveAt: sql<string>`${sessions.updatedAt}`,
    })
    .from(sessions)
    .innerJoin(projects, eq(projects.id, sessions.projectId))
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(...conditions))
    .orderBy(desc(sessions.updatedAt))
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
  readonly model: string | null
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
}

export type TokenUsageTotals = {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cachedTokens: number
  readonly thinkingTokens: number
}

export type SessionDetailRow = {
  readonly session: SessionFactsRow
  readonly messages: ReadonlyArray<MessageRow>
  readonly toolCalls: ReadonlyArray<ToolCallRow>
  readonly subagents: ReadonlyArray<SubagentRow>
  readonly tokenUsage: TokenUsageTotals
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
      model: sessions.model,
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
    .where(and(eq(sessions.id, sessionId), visibleToUser(db, userId)))
  return row
}

const EMPTY_TOKENS: TokenUsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  thinkingTokens: 0,
}

export const getDetail = async (
  db: Querier,
  userId: string,
  sessionId: string,
): Promise<SessionDetailRow | null> => {
  const facts = await findVisibleSession(db, userId, sessionId)
  if (!facts) return null

  const [messageRows, toolCallRows, subagentRows, tokenRows] = await Promise.all([
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
      })
      .from(subagents)
      .where(eq(subagents.sessionId, sessionId))
      .orderBy(asc(subagents.createdAt), asc(subagents.agentId)),
    db
      .select({
        inputTokens: sql<number>`coalesce(sum(${tokenUsage.inputTokens}), 0)::int`,
        outputTokens: sql<number>`coalesce(sum(${tokenUsage.outputTokens}), 0)::int`,
        cachedTokens: sql<number>`coalesce(sum(${tokenUsage.cachedTokens}), 0)::int`,
        thinkingTokens: sql<number>`coalesce(sum(${tokenUsage.thinkingTokens}), 0)::int`,
      })
      .from(tokenUsage)
      .innerJoin(messages, eq(messages.id, tokenUsage.messageId))
      .where(eq(messages.sessionId, sessionId)),
  ])

  return {
    session: facts,
    messages: messageRows,
    toolCalls: toolCallRows,
    subagents: subagentRows,
    tokenUsage: tokenRows[0] ?? EMPTY_TOKENS,
  }
}
