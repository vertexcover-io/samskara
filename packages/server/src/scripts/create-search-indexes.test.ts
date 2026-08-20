import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { createLogger } from "@samskara/core"
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import type postgres from "postgres"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { createDb } from "../db/client.js"
import { createSearchIndexes, warnMissingSearchIndexes } from "./create-search-indexes.js"

const dockerAvailable = () => {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

const packageDir = fileURLToPath(new URL("../..", import.meta.url))

const indexNames = async (sql: postgres.Sql): Promise<ReadonlyArray<string>> => {
  const rows = await sql<Array<{ relname: string }>>`
    select relname from pg_class where relname in ('messages_search_idx', 'sessions_search_idx')
  `
  return rows.map((row) => row.relname)
}

describe.skipIf(!dockerAvailable())("search index maintenance", () => {
  let container: StartedPostgreSqlContainer
  let teardown: () => Promise<void>
  let client: postgres.Sql

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start()
    const url = container.getConnectionUri()
    execFileSync("bun", ["run", "db:migrate"], {
      cwd: packageDir,
      env: { ...process.env, DATABASE_URL: url },
      stdio: "inherit",
    })
    const created = createDb(url)
    client = created.client
    teardown = async () => {
      await created.client.end()
      await container.stop()
    }
  }, 120_000)

  afterAll(async () => {
    await teardown?.()
  })

  test("warnMissingSearchIndexes logs a warning for each search index that does not exist yet", async () => {
    const lines: string[] = []
    const log = createLogger(
      { service: "test" },
      { level: "warn", destination: { write: (line: string) => lines.push(line) } },
    )

    await warnMissingSearchIndexes(client, log)

    const parsed = lines.map((line) => JSON.parse(line) as { level: number; index: string })
    expect(parsed).toHaveLength(2)
    expect(parsed.every((entry) => entry.level === 40)).toBe(true)
    expect(new Set(parsed.map((entry) => entry.index))).toEqual(
      new Set(["messages_search_idx", "sessions_search_idx"]),
    )
  })

  test("createSearchIndexes creates both named indexes idempotently, after which no missing-index warning is logged", async () => {
    const first = await createSearchIndexes(client)
    expect(first).toEqual([
      { name: "messages_search_idx", built: true },
      { name: "sessions_search_idx", built: true },
    ])
    expect(await indexNames(client)).toEqual(
      expect.arrayContaining(["messages_search_idx", "sessions_search_idx"]),
    )

    const second = await createSearchIndexes(client)
    expect(second).toEqual([
      { name: "messages_search_idx", built: false },
      { name: "sessions_search_idx", built: false },
    ])

    const lines: string[] = []
    const log = createLogger(
      { service: "test" },
      { level: "warn", destination: { write: (line: string) => lines.push(line) } },
    )
    await warnMissingSearchIndexes(client, log)
    expect(lines).toHaveLength(0)
  })
})
