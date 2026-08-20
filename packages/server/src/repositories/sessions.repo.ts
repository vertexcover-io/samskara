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
import { SEARCH_DOCUMENTS, type SearchSourceKind } from "../db/searchSql.js"
import { type SessionQuery, compileSessionQuery } from "../search/sessionQuery.js"
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

/**
 * Everything a session owns -- messages and their tool calls, subagents, artifacts, commit and
 * pull-request links -- is removed by the cascade, so the session row is the only delete needed.
 * Returns false when the session is absent or owned by someone else; the caller cannot tell those
 * apart, which is the same answer `getDetail` gives.
 */
export const remove = async (db: Querier, id: string, userId: string): Promise<boolean> => {
  const deleted = await db
    .delete(sessions)
    .where(and(eq(sessions.id, id), eq(sessions.userId, userId)))
    .returning({ id: sessions.id })
  return deleted.length > 0
}

export type SessionRepo = {
  readonly host: string
  readonly owner: string
  readonly repoName: string
}

export type SessionMatch = {
  readonly sourceKind: "session" | "message" | "pullRequest" | "toolCall" | "toolResult"
  readonly sourceRowId: string
  readonly score: number
  readonly snippet: ReadonlyArray<{ readonly text: string; readonly highlighted: boolean }>
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
  readonly match: SessionMatch | null
}

export type SessionFilterOption = { readonly value: string; readonly label: string }
export type SessionRepositoryFilterOption = {
  readonly value: string
  readonly label: string
  readonly host: string
  readonly owner: string
  readonly repoName: string
}

export type SessionFilterOptions = {
  readonly projects: ReadonlyArray<SessionFilterOption>
  readonly authors: ReadonlyArray<SessionFilterOption>
  readonly repositories: ReadonlyArray<SessionRepositoryFilterOption>
  readonly branches: ReadonlyArray<string>
}

/** The parser owns construction of this trusted tsquery SQL fragment. */
export type ParsedSessionQuery = SessionQuery

export type SessionListFilter = {
  readonly projectSlug?: string
  readonly userLogin?: string
  readonly repoId?: string
  readonly branch?: string
  readonly prNumber?: number
  readonly commit?: string
  readonly searchQuery?: ParsedSessionQuery
  readonly since?: Date
  /** Exclusive UTC boundary. */
  readonly until?: Date
  readonly sort?: "recent" | "oldest" | "tokens" | "project" | "relevance"
  readonly page?: number
  readonly limit?: number
}

export type SessionListResult = {
  readonly rows: ReadonlyArray<SessionSummaryRow>
  readonly total: number
  readonly filterOptions: SessionFilterOptions
}

export class AmbiguousCommitError extends Error {
  constructor() {
    super("ambiguous commit prefix")
    this.name = "AmbiguousCommitError"
  }
}

const ownMessages = sql`"messages" where "messages"."sessionId" = "sessions"."id"`
const messageCount = sql<number>`(select count(*)::int from ${ownMessages})`

const durationMs = sql<number | null>`(
  select (extract(epoch from max("messages"."timestamp") - min("messages"."timestamp")) * 1000)::bigint
  from ${ownMessages}
  having count("messages"."timestamp") > 1
)`

const tokensFor = (sessionId: SQL): SQL<number> => sql`(
  select coalesce(sum(
    "tokenUsage"."inputTokens"::bigint + "tokenUsage"."outputTokens"::bigint
    + "tokenUsage"."cachedTokens"::bigint + "tokenUsage"."thinkingTokens"::bigint
  ), 0)::bigint
  from "tokenUsage"
  join "messages" on "messages"."id" = "tokenUsage"."messageId"
  where "messages"."sessionId" = ${sessionId}
)`

const tokensTotal = tokensFor(sql`"sessions"."id"`)

const status = sql<string>`case when ${messageCount} = 0 then 'empty' else 'complete' end`

const dominantRepoId = sql`(
  select "messages"."repoId"
  from ${ownMessages} and "messages"."repoId" is not null
  group by "messages"."repoId"
  order by count(*) desc, min("messages"."lineNumber") asc
  limit 1
)`

const repoColumns = { repoHost: repos.host, repoOwner: repos.owner, repoName: repos.repoName }
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

const derivedTitle = sql<string | null>`coalesce(${sessions.title}, (
  select left(btrim(split_part(coalesce(m."content"->>'value', m."content"->>'text', m."content"->>'body'), chr(10), 1)), 120)
  from "messages" m
  where m."sessionId" = ${sessions.id} and m."msgType" = 'message' and m."role" = 'user'
    and coalesce(m."content"->>'value', m."content"->>'text', m."content"->>'body') is not null
    and btrim(coalesce(m."content"->>'value', m."content"->>'text', m."content"->>'body')) <> ''
  order by m."lineNumber" asc limit 1
))`

/**
 * Runtime match/rank/headline expressions derive from the index catalogue rather than maintaining
 * a second hand-written copy. Only these fixed aliases are accepted, so replacement cannot admit
 * user SQL identifiers.
 */
const canonicalExpression = (sourceKind: SearchSourceKind, alias: string): string => {
  const document = SEARCH_DOCUMENTS.find((candidate) => candidate.sourceKind === sourceKind)
  if (document === undefined) throw new Error(`missing canonical search document: ${sourceKind}`)
  return document.vector.replaceAll(`"${document.table}".`, `${alias}.`)
}

const canonicalVector = (sourceKind: SearchSourceKind, alias: string): SQL =>
  sql.raw(canonicalExpression(sourceKind, alias))

const canonicalText = (sourceKind: SearchSourceKind, alias: string): SQL => {
  const vector = canonicalExpression(sourceKind, alias)
  const prefix = "to_tsvector('simple'::regconfig, public.samskara_search_cap("
  const suffix = "))"
  if (!vector.startsWith(prefix) || !vector.endsWith(suffix)) {
    throw new Error(`unreadable canonical search document: ${sourceKind}`)
  }
  return sql.raw(`public.samskara_search_cap(${vector.slice(prefix.length, -suffix.length)})`)
}

const SNIPPET_START = "[[[samskara-match-4f481d8b]]]"
const SNIPPET_STOP = "[[[/samskara-match-4f481d8b]]]"
const SNIPPET_OPTIONS = `StartSel=${SNIPPET_START}, StopSel=${SNIPPET_STOP}, MaxWords=35, MinWords=10, MaxFragments=2, FragmentDelimiter= … `

/** A malformed headline is decorative data: retain text, never trust marker-shaped source content. */
const safeSnippet = (
  source: string,
  headline: string,
): ReadonlyArray<{ readonly text: string; readonly highlighted: boolean }> => {
  const unhighlighted = (
    value: string,
  ): ReadonlyArray<{ readonly text: string; readonly highlighted: boolean }> => {
    const text = value.replaceAll(SNIPPET_START, "").replaceAll(SNIPPET_STOP, "").slice(0, 4_000)
    return text === "" ? [] : [{ text, highlighted: false }]
  }
  if (source.includes(SNIPPET_START) || source.includes(SNIPPET_STOP) || headline.length > 4_000) {
    return unhighlighted(headline)
  }
  const segments: Array<{ text: string; highlighted: boolean }> = []
  let cursor = 0
  let highlighted = false
  while (cursor < headline.length) {
    const marker = highlighted ? SNIPPET_STOP : SNIPPET_START
    const next = headline.indexOf(marker, cursor)
    if (next < 0) {
      const text = headline.slice(cursor)
      if (text) segments.push({ text, highlighted })
      cursor = headline.length
      break
    }
    const text = headline.slice(cursor, next)
    if (text) segments.push({ text, highlighted })
    cursor = next + marker.length
    highlighted = !highlighted
  }
  if (
    highlighted ||
    segments.length > 32 ||
    segments.reduce((length, part) => length + part.text.length, 0) > 4_000
  ) {
    return [
      {
        text: headline.replaceAll(SNIPPET_START, "").replaceAll(SNIPPET_STOP, "").slice(0, 4_000),
        highlighted: false,
      },
    ]
  }
  return segments
}

const authorizationCte = (db: Querier, userId: string) => sql`
  authorized_sessions AS MATERIALIZED (
    select "sessions"."id", "sessions"."title", "sessions"."updatedAt", "projects"."name" as "projectName", "projects"."slug" as "projectSlug", "users"."github_login" as "userLogin"
    from "sessions"
    join "projects" on "projects"."id" = "sessions"."projectId"
    join "users" on "users"."id" = "sessions"."userId"
    where ${visibleToUser(db, userId)}
  )`

/** Resolve only after visibility has been established, so hidden SHAs cannot cause ambiguity. */
const resolveCommit = async (
  db: Querier,
  userId: string,
  prefix: string,
): Promise<string | null> => {
  const rows = (await db.execute(sql`
    with ${authorizationCte(db, userId)}
    select distinct c."sha" as sha
    from "commits" c join authorized_sessions a on a.id = c."sessionId"
    where c."sha" ~ '^[0-9A-Fa-f]{7,40}$'
      and (lower(c."sha") = lower(${prefix}) or lower(c."sha") like lower(${prefix}) || '%')
  `)) as ReadonlyArray<{ sha: string }>
  const exact = rows.filter((row) => row.sha.toLowerCase() === prefix)
  if (exact.length > 0) return exact[0]?.sha ?? null
  if (rows.length > 1) throw new AmbiguousCommitError()
  return rows[0]?.sha ?? null
}

const filterPredicates = (
  filter: SessionListFilter,
  resolvedCommit: string | null | undefined,
): SQL[] => {
  const clauses: SQL[] = []
  if (filter.projectSlug !== undefined) clauses.push(sql`a."projectSlug" = ${filter.projectSlug}`)
  if (filter.userLogin !== undefined) clauses.push(sql`a."userLogin" = ${filter.userLogin}`)
  if (filter.since !== undefined) clauses.push(sql`a."updatedAt" >= ${filter.since.toISOString()}`)
  if (filter.until !== undefined) clauses.push(sql`a."updatedAt" < ${filter.until.toISOString()}`)
  if (filter.repoId !== undefined)
    clauses.push(sql`(
    exists (select 1 from "messages" m where m."sessionId" = a.id and m."repoId" = ${filter.repoId})
    or exists (select 1 from "commits" c where c."sessionId" = a.id and c."repoId" = ${filter.repoId})
    or exists (select 1 from "sessionPullRequests" sp join "pullRequests" pr on pr.id = sp."prId" where sp."sessionId" = a.id and pr."repoId" = ${filter.repoId})
  )`)
  if (filter.branch !== undefined)
    clauses.push(sql`(
    exists (select 1 from "messages" m where m."sessionId" = a.id and m."gitBranch" = ${filter.branch})
    or exists (select 1 from "commits" c where c."sessionId" = a.id and c."branch" = ${filter.branch})
    or exists (select 1 from "sessionPullRequests" sp join "pullRequests" pr on pr.id = sp."prId" where sp."sessionId" = a.id and (pr."baseBranch" = ${filter.branch} or pr."headBranch" = ${filter.branch}))
  )`)
  if (filter.prNumber !== undefined)
    clauses.push(
      sql`exists (select 1 from "sessionPullRequests" sp join "pullRequests" pr on pr.id = sp."prId" where sp."sessionId" = a.id and pr."number" = ${filter.prNumber})`,
    )
  // A syntactically valid but unresolved prefix must narrow to nothing, rather than silently vanish.
  if (filter.commit !== undefined)
    clauses.push(
      resolvedCommit === null
        ? sql`false`
        : sql`exists (select 1 from "commits" c where c."sessionId" = a.id and lower(c."sha") = ${resolvedCommit?.toLowerCase()})`,
    )
  return clauses
}

const filterOptionsFor = async (db: Querier, userId: string): Promise<SessionFilterOptions> => {
  const [projectsRows, authorRows, repoRows, branchRows] = await Promise.all([
    db.execute(
      sql`with ${authorizationCte(db, userId)} select distinct "projectSlug" as value, "projectName" as label from authorized_sessions order by label, value`,
    ),
    db.execute(
      sql`with ${authorizationCte(db, userId)} select distinct "userLogin" as value, "userLogin" as label from authorized_sessions order by value`,
    ),
    db.execute(
      sql`with ${authorizationCte(db, userId)} select distinct r.id as value, concat(r.owner, '/', r."repo_name") as label, r.host, r.owner, r."repo_name" as "repoName" from "repos" r where exists (select 1 from "messages" m where m."sessionId" in (select id from authorized_sessions) and m."repoId" = r.id) or exists (select 1 from "commits" c where c."sessionId" in (select id from authorized_sessions) and c."repoId" = r.id) or exists (select 1 from "pullRequests" pr join "sessionPullRequests" sp on sp."prId" = pr.id where sp."sessionId" in (select id from authorized_sessions) and pr."repoId" = r.id) order by label, value`,
    ),
    db.execute(
      sql`with ${authorizationCte(db, userId)}, values_ as (select m."gitBranch" as branch from "messages" m join authorized_sessions a on a.id = m."sessionId" union select c.branch from "commits" c join authorized_sessions a on a.id = c."sessionId" union select pr."baseBranch" from "pullRequests" pr join "sessionPullRequests" sp on sp."prId" = pr.id join authorized_sessions a on a.id = sp."sessionId" union select pr."headBranch" from "pullRequests" pr join "sessionPullRequests" sp on sp."prId" = pr.id join authorized_sessions a on a.id = sp."sessionId") select distinct branch collate "C" as branch from values_ where branch is not null and branch <> '' order by branch`,
    ),
  ])
  return {
    projects: projectsRows as unknown as ReadonlyArray<SessionFilterOption>,
    authors: authorRows as unknown as ReadonlyArray<SessionFilterOption>,
    repositories: repoRows as unknown as ReadonlyArray<SessionRepositoryFilterOption>,
    branches: (branchRows as unknown as ReadonlyArray<{ branch: string }>).map((row) => row.branch),
  }
}

export const listAccessible = async (
  db: Querier,
  userId: string,
  filter: SessionListFilter = {},
): Promise<SessionListResult> => {
  const page = filter.page ?? 1
  const limit = filter.limit ?? 50
  const offset = (page - 1) * limit
  const resolvedCommit =
    filter.commit === undefined ? undefined : await resolveCommit(db, userId, filter.commit)
  const predicates = filterPredicates(filter, resolvedCommit)
  const where = predicates.length === 0 ? sql`true` : sql.join(predicates, sql` and `)
  const filtered = sql`filtered_sessions as materialized (select a.* from authorized_sessions a where ${where})`
  const query =
    filter.searchQuery === undefined ? undefined : compileSessionQuery(filter.searchQuery)
  const matches =
    query === undefined
      ? sql`
    matched_sessions as (
      select f.*, null::text as "sourceKind", null::text as "sourceRowId", null::text as "sourceText", null::real as score, 0::int as "matchedRows"
      from filtered_sessions f
    )`
      : sql`
    source_matches as (
      -- Keep the canonical expression qualified by the base table name: PostgreSQL can then match the sessions GIN expression index.
      select f.id, 'session'::text as "sourceKind", f.id as "sourceRowId", ${canonicalText("session", "s")} as "sourceText", 4.0 * ts_rank_cd(${canonicalVector("session", "s")}, ${query}, 32) as score from filtered_sessions f join "sessions" s on s.id = f.id where ${canonicalVector("session", "s")} @@ ${query}
      union all select f.id, 'message', m.id::text, ${canonicalText("message", "m")}, 1.5 * ts_rank_cd(${canonicalVector("message", "m")}, ${query}, 32) from filtered_sessions f join "messages" m on m."sessionId" = f.id where ${canonicalVector("message", "m")} @@ ${query}
      union all select f.id, 'pullRequest', pr.id::text, ${canonicalText("pullRequest", "pr")}, 3.0 * ts_rank_cd(${canonicalVector("pullRequest", "pr")}, ${query}, 32) from filtered_sessions f join "sessionPullRequests" sp on sp."sessionId" = f.id join "pullRequests" pr on pr.id = sp."prId" where ${canonicalVector("pullRequest", "pr")} @@ ${query}
      union all select f.id, 'toolCall', concat(tc."messageId"::text, ':', tc."toolId"), ${canonicalText("toolCall", "tc")}, 1.0 * ts_rank_cd(${canonicalVector("toolCall", "tc")}, ${query}, 32) from filtered_sessions f join "messages" m on m."sessionId" = f.id join "toolCall" tc on tc."messageId" = m.id where ${canonicalVector("toolCall", "tc")} @@ ${query}
      union all select f.id, 'toolResult', concat(tr."messageId"::text, ':', tr."toolId"), ${canonicalText("toolResult", "tr")}, 0.75 * ts_rank_cd(${canonicalVector("toolResult", "tr")}, ${query}, 32) from filtered_sessions f join "messages" m on m."sessionId" = f.id join "toolResult" tr on tr."messageId" = m.id where ${canonicalVector("toolResult", "tr")} @@ ${query}
    ), matched_sessions as (
      select distinct on (f.id) f.*, sm."sourceKind", sm."sourceRowId", sm."sourceText", sm.score, count(*) over (partition by f.id)::int as "matchedRows"
      from filtered_sessions f join source_matches sm on sm.id = f.id
      order by f.id, sm.score desc, case sm."sourceKind" when 'session' then 1 when 'pullRequest' then 2 when 'message' then 3 when 'toolCall' then 4 else 5 end, sm."sourceRowId"
    )`
  const isTokenSort = filter.sort === "tokens"
  const order =
    filter.sort === "oldest"
      ? sql`"updatedAt" asc, id asc`
      : isTokenSort
        ? sql`"tokensTotal" desc, id asc`
        : filter.sort === "project"
          ? sql`"projectName" asc, id asc`
          : query !== undefined && (filter.sort === undefined || filter.sort === "relevance")
            ? sql`score desc, "matchedRows" desc, "updatedAt" desc, id asc`
            : sql`"updatedAt" desc, id asc`
  const finalOrder =
    filter.sort === "oldest"
      ? sql`p."updatedAt" asc, p.id asc`
      : isTokenSort
        ? sql`p."tokensTotal" desc, p.id asc`
        : filter.sort === "project"
          ? sql`p."projectName" asc, p.id asc`
          : query !== undefined && (filter.sort === undefined || filter.sort === "relevance")
            ? sql`p.score desc, p."matchedRows" desc, p."updatedAt" desc, p.id asc`
            : sql`p."updatedAt" desc, p.id asc`
  const rows = (await db.execute(sql`
    with ${authorizationCte(db, userId)}, ${filtered}, ${matches}, ranked as (
      select ms.*, ${isTokenSort ? tokensFor(sql`ms.id`) : sql`null::bigint`} as "tokensTotal", count(*) over()::int as total
      from matched_sessions ms
    ), paged as (select * from ranked order by ${order} limit ${limit} offset ${offset})
    select p.id, ${derivedTitle} as title, p."projectName", p."projectSlug", p."userLogin",
      r.host as "repoHost", r.owner as "repoOwner", r."repo_name" as "repoName", ${durationMs} as "durationMs",
      ${isTokenSort ? sql`p."tokensTotal"` : tokensFor(sql`"sessions"."id"`)} as "tokensTotal", ${status} as status,
      p."updatedAt" as "lastActiveAt", p."sourceKind", p."sourceRowId", p.score, p.total,
      case when p."sourceText" is null then null else ts_headline('simple'::regconfig, p."sourceText", ${query ?? sql`null::tsquery`}, ${SNIPPET_OPTIONS}) end as headline
    from paged p join "sessions" on "sessions".id = p.id left join "repos" r on r.id = ${dominantRepoId}
    order by ${finalOrder}
  `)) as ReadonlyArray<Record<string, unknown>>
  const total =
    rows.length === 0
      ? Number(
          (
            (await db.execute(
              sql`with ${authorizationCte(db, userId)}, ${filtered}, ${matches} select count(*)::int as total from matched_sessions`,
            )) as ReadonlyArray<{ total: number }>
          )[0]?.total ?? 0,
        )
      : Number(rows[0]?.total)
  const mapped = rows.map((row) =>
    withRepo({
      id: row.id as string,
      title: row.title as string | null,
      projectName: row.projectName as string,
      projectSlug: row.projectSlug as string,
      userLogin: row.userLogin as string,
      repoHost: row.repoHost as string | null,
      repoOwner: row.repoOwner as string | null,
      repoName: row.repoName as string | null,
      durationMs: row.durationMs === null ? null : Number(row.durationMs),
      tokensTotal: Number(row.tokensTotal),
      status: row.status as string,
      lastActiveAt: String(row.lastActiveAt),
      match:
        row.sourceKind === null
          ? null
          : {
              sourceKind: row.sourceKind as SessionMatch["sourceKind"],
              sourceRowId: String(row.sourceRowId),
              score: Number(row.score),
              snippet: safeSnippet(String(row.sourceText), String(row.headline)),
            },
    }),
  )
  return { rows: mapped, total, filterOptions: await filterOptionsFor(db, userId) }
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
