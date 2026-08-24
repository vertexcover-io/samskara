import { createHash } from "node:crypto"
import postgres from "postgres"

export const E2E_USER_ID = "00000000-0000-0000-0000-000000000001"
export const E2E_USER_LOGIN = "e2e-user"

export const E2E_OTHER_USER_ID = "00000000-0000-0000-0000-000000000002"
export const E2E_OTHER_USER_LOGIN = "e2e-maya"

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://samskara:samskara@localhost:5433/samskara"

export type SeedRepository = {
  readonly key: string
  readonly host: string
  readonly owner: string
  readonly repoName: string
  readonly ownerUser?: "primary" | "other"
}

export type SeedMessage = {
  readonly id?: string
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

const seedMessages = async (
  sql: Sql,
  session: SeedSession,
  repositories: RepositoryIds,
): Promise<void> => {
  for (const [line, entry] of (session.messages ?? []).entries()) {
    const timestamp = new Date(Date.UTC(2026, 2, 1, 10, line))
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
      insert into repos (host, owner, repo_name, "userId")
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

export const seedDatabase = async (spec: SeedSpec): Promise<void> => {
  const sql = postgres(DATABASE_URL)
  const projectIds = spec.projects.map((project) => projectId(project.slug))
  const orgSlugs = [
    ...new Set([
      ...spec.projects.flatMap((project) => (project.org === undefined ? [] : [project.org])),
      ...Object.keys(spec.orgMembers ?? {}),
    ]),
  ]

  try {
    // Every project ID is derived from its E2E-only slug, so this clears hidden-project fixtures
    // as well as visible ones without touching a non-E2E project owned by the second test user.
    if (projectIds.length > 0) {
      await sql`delete from "userProjectGrant" where "projectId" in ${sql(projectIds)}`
      await sql`delete from projects where id in ${sql(projectIds)}`
    }
    await sql`delete from user_orgs where user_id in (${E2E_USER_ID}, ${E2E_OTHER_USER_ID})`
    // Deleted by slug, not by the deterministic id: the insert below is `on conflict
    // (github_slug) do update`, so a row a developer created by hand (e.g. `bun run seed:org
    // acme`, which gets a random id) survives a delete keyed on the deterministic id and every
    // later insert that assumes that id -- user_orgs, projects."ownerOrgId" -- hits a foreign
    // key violation. Cascading deletes on those FKs make this safe to run before re-inserting.
    if (orgSlugs.length > 0) {
      await sql`delete from orgs where github_slug in ${sql(orgSlugs)}`
    }
    // A spec outside this file (e.g. capture-pipeline.spec.ts's real watcher) can create a
    // project/session/repo trio this seed's projectIds list never names. Clearing every e2e
    // user's sessions -- cascading their messages/commits -- before the repos delete keeps that
    // leftover from blocking it on a foreign key.
    await sql`delete from sessions where "userId" in (${E2E_USER_ID}, ${E2E_OTHER_USER_ID})`
    await sql`delete from repos where "userId" in (${E2E_USER_ID}, ${E2E_OTHER_USER_ID})`

    await sql`
      insert into users (id, github_id, github_login, email, name)
      values (${E2E_USER_ID}, 999001, ${E2E_USER_LOGIN}, 'e2e@example.com', 'E2E User')
      on conflict (id) do update set github_login = excluded.github_login
    `

    await sql`
      insert into users (id, github_id, github_login, email, name)
      values (${E2E_OTHER_USER_ID}, 999002, ${E2E_OTHER_USER_LOGIN}, 'maya@example.com', 'Maya')
      on conflict (id) do update set github_login = excluded.github_login
    `

    for (const slug of orgSlugs) {
      await sql`
        insert into orgs (id, github_slug, "autoAddMembers")
        values (${orgId(slug)}, ${slug}, true)
        on conflict (github_slug) do update set "autoAddMembers" = excluded."autoAddMembers"
      `
      for (const member of spec.orgMembers?.[slug] ?? ["primary"]) {
        const userId = member === "other" ? E2E_OTHER_USER_ID : E2E_USER_ID
        await sql`insert into user_orgs (user_id, org_id) values (${userId}, ${orgId(slug)}) on conflict do nothing`
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

        await seedMessages(sql, session, repositories)
        await seedStructuredFacts(sql, session, repositories)
      }
    }
  } finally {
    await sql.end()
  }
}
