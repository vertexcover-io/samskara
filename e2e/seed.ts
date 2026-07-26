import { createHash } from "node:crypto"
import postgres from "postgres"

export const E2E_USER_ID = "00000000-0000-0000-0000-000000000001"
export const E2E_USER_LOGIN = "e2e-user"

export const E2E_OTHER_USER_ID = "00000000-0000-0000-0000-000000000002"
export const E2E_OTHER_USER_LOGIN = "e2e-maya"

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://samskara:samskara@localhost:5433/samskara"

export type SeedMessage = {
  readonly msgType: string
  readonly subType?: string
  readonly role?: string
  readonly agentId?: string
  readonly isSubagent?: boolean
  readonly content?: unknown
  readonly details?: unknown
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

export type SeedSession = {
  readonly id: string
  readonly title: string
  readonly author?: "primary" | "other"
  readonly messages?: ReadonlyArray<SeedMessage>
  readonly subagents?: ReadonlyArray<SeedSubagent>
}

export type SeedProject = {
  readonly slug: string
  readonly name: string
  readonly sessions: ReadonlyArray<SeedSession>
}

export type SeedSpec = {
  readonly projects: ReadonlyArray<SeedProject>
}

const projectId = (slug: string): string => {
  const hex = createHash("sha1").update(`e2e:${slug}`).digest("hex")
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-")
}

type Sql = ReturnType<typeof postgres>

const jsonOrNull = (value: unknown): string | null =>
  value === undefined ? null : JSON.stringify(value)

const seedMessages = async (sql: Sql, session: SeedSession): Promise<void> => {
  for (const [line, entry] of (session.messages ?? []).entries()) {
    const timestamp = new Date(Date.UTC(2026, 2, 1, 10, line))
    const [row] = await sql`
      insert into "messages" (
        "sessionId", "lineUuid", "subIndex", "msgType", "subType", role, timestamp,
        "lineNumber", "agentId", "isSubagent", content, details, raw, "sourceSchemaVersion"
      )
      values (
        ${session.id}, gen_random_uuid(), 0, ${entry.msgType}, ${entry.subType ?? null},
        ${entry.role ?? null}, ${timestamp}, ${line + 1}, ${entry.agentId ?? null},
        ${entry.isSubagent ?? false}, ${jsonOrNull(entry.content)}, ${jsonOrNull(entry.details)},
        '{}'::jsonb, 1
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

export const seedDatabase = async (spec: SeedSpec): Promise<void> => {
  const sql = postgres(DATABASE_URL)

  try {
    await sql`delete from "sessions" where "userId" in (${E2E_USER_ID}, ${E2E_OTHER_USER_ID})`
    await sql`delete from "userProjectGrant" where "userId" = ${E2E_USER_ID}`
    await sql`delete from "projects" where "ownerId" = ${E2E_USER_ID}`

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

    for (const [index, project] of spec.projects.entries()) {
      const id = projectId(project.slug)
      await sql`
        insert into "projects" (id, name, slug, "ownerId")
        values (${id}, ${project.name}, ${project.slug}, ${E2E_USER_ID})
      `

      for (const [order, session] of project.sessions.entries()) {
        const updatedAt = new Date(Date.UTC(2026, 1, 1 + index, 9, order))
        const author = session.author === "other" ? E2E_OTHER_USER_ID : E2E_USER_ID
        await sql`
          insert into "sessions" (id, source, "userId", "projectId", title, "updatedAt")
          values (${session.id}, 'claude_code', ${author}, ${id}, ${session.title}, ${updatedAt})
        `

        for (const agent of session.subagents ?? []) {
          await sql`
            insert into "subagents" ("sessionId", "agentId", "agentType", description, "sourceRelativePath")
            values (${session.id}, ${agent.agentId}, ${agent.agentType}, ${agent.description}, ${`sub/${agent.agentId}.jsonl`})
          `
        }

        await seedMessages(sql, session)
      }
    }
  } finally {
    await sql.end()
  }
}
