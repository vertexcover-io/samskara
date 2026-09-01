import { createHash } from "node:crypto"
import postgres from "postgres"
import { requireDatabaseUrl } from "./db.js"

export const E2E_USER_ID = "00000000-0000-0000-0000-000000000001"
export const E2E_USER_LOGIN = "e2e-user"

export const E2E_OTHER_USER_ID = "00000000-0000-0000-0000-000000000002"
export const E2E_OTHER_USER_LOGIN = "e2e-maya"

const DATABASE_URL = requireDatabaseUrl()

export type SeedRepository = {
  readonly key: string
  readonly host: string
  readonly owner: string
  readonly repoName: string
  readonly ownerUser?: "primary" | "other"
}

export type SeedMessage = {
  readonly id?: string
  /** Defaults to the session's own time, which is what keeps the list in seed order. */
  readonly timestamp?: Date
  readonly msgType: string
  readonly subType?: string
  readonly role?: string
  readonly agentId?: string
  readonly isSubagent?: boolean
  readonly content?: unknown
  readonly details?: unknown
  readonly repository?: string
  readonly gitBranch?: string
  readonly tool?: {
    readonly toolId: string
    readonly toolName: string
    readonly toolInput: unknown
    readonly result?: unknown
    readonly status?: string
  }
  readonly tokens?: { readonly input: number; readonly output: number }
}

export type SeedSubagent = {
  readonly agentId: string
  readonly agentType: string
  readonly description: string
}

export type SeedCommit = {
  readonly repository: string
  readonly sha: string
  readonly branch?: string
  readonly subject?: string
}

export type SeedPullRequest = {
  readonly repository: string
  readonly number: number
  readonly title?: string
  readonly baseBranch?: string
  readonly headBranch?: string
}

export type SeedSession = {
  readonly id: string
  readonly title: string
  readonly author?: "primary" | "other"
  readonly messages?: ReadonlyArray<SeedMessage>
  readonly commits?: ReadonlyArray<SeedCommit>
  readonly pullRequests?: ReadonlyArray<SeedPullRequest>
  readonly subagents?: ReadonlyArray<SeedSubagent>
}

export type SeedProject = {
  readonly slug: string
  readonly name: string
  /** Other-owned projects are intentionally not granted to the E2E user. */
  readonly owner?: "primary" | "other"
  /** An org-owned project instead of a user-owned one. Mutually exclusive with `owner`. */
  readonly org?: string
  readonly sessions: ReadonlyArray<SeedSession>
}

export type SeedSpec = {
  readonly repositories?: ReadonlyArray<SeedRepository>
  readonly projects: ReadonlyArray<SeedProject>
  /** Org membership for a project's org, keyed by org slug. Defaults to `["primary"]`. */
  readonly orgMembers?: Record<string, ReadonlyArray<"primary" | "other">>
  /** `autoAddMembers` for a seeded org, keyed by org slug. Defaults to `true`. */
  readonly orgAutoAdd?: Record<string, boolean>
  /** Which seeded users get `isSuperAdmin`. Defaults to neither. */
  readonly superAdmins?: ReadonlyArray<"primary" | "other">
}

// Forces the version (4) and variant (8-b) nibbles so the result satisfies zod's `.uuid()`
// format check -- a raw hash slice lands outside that range often enough to break any schema
// that validates a seeded id (e.g. `projectId` on the ingest payload).
const deterministicUuid = (value: string): string => {
  const hex = createHash("sha1").update(value).digest("hex")
  const variant = "89ab"[Number.parseInt(hex[16] ?? "0", 16) % 4]
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-")
}

export const projectId = (slug: string): string => deterministicUuid(`e2e:${slug}`)
export const orgId = (slug: string): string => deterministicUuid(`org:${slug}`)
const seededMessageId = (sessionId: string, line: number): string =>
  deterministicUuid(`e2e:${sessionId}:${line}`)

type Sql = ReturnType<typeof postgres>

type RepositoryIds = ReadonlyMap<string, string>

const jsonOrNull = (value: unknown): string | null =>
  value === undefined ? null : JSON.stringify(value)

const repositoryId = (repositories: RepositoryIds, key: string | undefined): string | null => {
  if (key === undefined) return null
  const id = repositories.get(key)
  if (id === undefined) throw new Error(`seed references unknown repository: ${key}`)
  return id
}

// The messages trigger turns message times into the session's activity, and the list sorts by
// activity. Stamping each message with its session's own time keeps that equal to updatedAt, so
// the list stays in seed order. A spec that needs a different time says so on the message.
const seedMessages = async (
  sql: Sql,
  session: SeedSession,
  repositories: RepositoryIds,
  sessionAt: Date,
): Promise<void> => {
  for (const [line, entry] of (session.messages ?? []).entries()) {
    const timestamp = entry.timestamp ?? sessionAt
    const [row] = await sql`
      insert into "messages" (
        id, "sessionId", "lineUuid", "subIndex", "msgType", "subType", role, timestamp,
        "lineNumber", "agentId", "isSubagent", content, details, raw, "sourceSchemaVersion", "repoId", "gitBranch"
      )
      values (
        ${entry.id ?? seededMessageId(session.id, line)}, ${session.id}, gen_random_uuid(), 0, ${entry.msgType}, ${entry.subType ?? null},
        ${entry.role ?? null}, ${timestamp}, ${line + 1}, ${entry.agentId ?? null}, ${entry.isSubagent ?? false},
        ${jsonOrNull(entry.content)}, ${jsonOrNull(entry.details)}, '{}'::jsonb, 1, ${repositoryId(repositories, entry.repository)}, ${entry.gitBranch ?? null}
      )
      returning id
    `
    const messageId: unknown = row?.id
    if (typeof messageId !== "string") throw new Error("seeded message returned no id")

    if (entry.tool) {
      await sql`
        insert into "toolCall" ("toolId", "messageId", "toolName", "toolInput")
        values (${entry.tool.toolId}, ${messageId}, ${entry.tool.toolName}, ${JSON.stringify(entry.tool.toolInput)})
      `
      if (entry.tool.result !== undefined) {
        await sql`
          insert into "toolResult" ("toolId", "messageId", result, status)
          values (${entry.tool.toolId}, ${messageId}, ${JSON.stringify(entry.tool.result)}, ${entry.tool.status ?? "success"})
        `
      }
    }

    if (entry.tokens) {
      await sql`
        insert into "tokenUsage" ("messageId", "inputTokens", "outputTokens", "cachedTokens", "thinkingTokens")
        values (${messageId}, ${entry.tokens.input}, ${entry.tokens.output}, 0, 0)
      `
    }
  }
}

const seedRepositories = async (
  sql: Sql,
  repositories: ReadonlyArray<SeedRepository>,
): Promise<RepositoryIds> => {
  const ids = new Map<string, string>()
  for (const repository of repositories) {
    const userId = repository.ownerUser === "other" ? E2E_OTHER_USER_ID : E2E_USER_ID
    const [row] = await sql`
      insert into repos (host, owner, "repoName", "userId")
      values (${repository.host}, ${repository.owner}, ${repository.repoName}, ${userId})
      returning id
    `
    if (typeof row?.id !== "string")
      throw new Error(`seeded repository returned no id: ${repository.key}`)
    ids.set(repository.key, row.id)
  }
  return ids
}

const seedStructuredFacts = async (
  sql: Sql,
  session: SeedSession,
  repositories: RepositoryIds,
): Promise<void> => {
  for (const commit of session.commits ?? []) {
    await sql`
      insert into commits ("repoId", sha, branch, subject, "sessionId")
      values (${repositoryId(repositories, commit.repository)}, ${commit.sha}, ${commit.branch ?? null}, ${commit.subject ?? null}, ${session.id})
    `
  }
  for (const pullRequest of session.pullRequests ?? []) {
    const [pr] = await sql`
      insert into "pullRequests" ("repoId", number, title, "baseBranch", "headBranch")
      values (${repositoryId(repositories, pullRequest.repository)}, ${pullRequest.number}, ${pullRequest.title ?? null}, ${pullRequest.baseBranch ?? null}, ${pullRequest.headBranch ?? null})
      returning id
    `
    if (typeof pr?.id !== "string") throw new Error("seeded pull request returned no id")
    await sql`
      insert into "sessionPullRequests" ("sessionId", "prId")
      values (${session.id}, ${pr.id})
    `
  }
}

// Reads the table list from the catalog so a table added later is cleared without an edit here.
// `schemaname = 'public'` is load-bearing: drizzle's ledger lives in its own schema, and clearing
// it would make the next `db:migrate` replay all migrations against a database that already has
// the tables.
const truncateAll = async (sql: Sql): Promise<void> => {
  const [row] = await sql<{ statement: string | null }[]>`
    select 'truncate table '
           || string_agg(format('%I.%I', schemaname, tablename), ', ')
           || ' restart identity cascade' as statement
    from pg_tables
    where schemaname = 'public'
  `
  if (row?.statement) await sql.unsafe(row.statement)
}

export const seedDatabase = async (spec: SeedSpec): Promise<void> => {
  const sql = postgres(DATABASE_URL)
  const orgSlugs = [
    ...new Set([
      ...spec.projects.flatMap((project) => (project.org === undefined ? [] : [project.org])),
      ...Object.keys(spec.orgMembers ?? {}),
    ]),
  ]

  try {
    await truncateAll(sql)

    await sql`
      insert into users (id, "githubId", "githubLogin", email, name, "isSuperAdmin")
      values (${E2E_USER_ID}, 999001, ${E2E_USER_LOGIN}, 'e2e@example.com', 'E2E User', ${spec.superAdmins?.includes("primary") ?? false})
    `

    await sql`
      insert into users (id, "githubId", "githubLogin", email, name, "isSuperAdmin")
      values (${E2E_OTHER_USER_ID}, 999002, ${E2E_OTHER_USER_LOGIN}, 'maya@example.com', 'Maya', ${spec.superAdmins?.includes("other") ?? false})
    `

    for (const slug of orgSlugs) {
      const autoAddMembers = spec.orgAutoAdd?.[slug] ?? true
      await sql`
        insert into orgs (id, "githubSlug", "autoAddMembers")
        values (${orgId(slug)}, ${slug}, ${autoAddMembers})
        on conflict ("githubSlug") do update set "autoAddMembers" = excluded."autoAddMembers"
      `
      for (const member of spec.orgMembers?.[slug] ?? ["primary"]) {
        const userId = member === "other" ? E2E_OTHER_USER_ID : E2E_USER_ID
        await sql`insert into "userOrgs" ("userId", "orgId") values (${userId}, ${orgId(slug)}) on conflict do nothing`
      }
    }

    const repositories = await seedRepositories(sql, spec.repositories ?? [])
    for (const [index, project] of spec.projects.entries()) {
      const id = projectId(project.slug)
      const ownerUserId =
        project.org === undefined
          ? project.owner === "other"
            ? E2E_OTHER_USER_ID
            : E2E_USER_ID
          : null
      const ownerOrgId = project.org === undefined ? null : orgId(project.org)
      await sql`
        insert into projects (id, name, slug, "ownerId", "ownerOrgId")
        values (${id}, ${project.name}, ${project.slug}, ${ownerUserId}, ${ownerOrgId})
      `

      for (const [order, session] of project.sessions.entries()) {
        const updatedAt = new Date(Date.UTC(2026, 1, 1 + index, 9, order))
        const author = session.author === "other" ? E2E_OTHER_USER_ID : E2E_USER_ID
        await sql`
          insert into sessions (id, source, "userId", "projectId", title, "updatedAt")
          values (${session.id}, 'claude_code', ${author}, ${id}, ${session.title}, ${updatedAt})
        `

        for (const agent of session.subagents ?? []) {
          await sql`
            insert into subagents ("sessionId", "agentId", "agentType", description, "sourceRelativePath")
            values (${session.id}, ${agent.agentId}, ${agent.agentType}, ${agent.description}, ${`sub/${agent.agentId}.jsonl`})
          `
        }

        await seedMessages(sql, session, repositories, updatedAt)
        await seedStructuredFacts(sql, session, repositories)
      }
    }
  } finally {
    await sql.end()
  }
}
