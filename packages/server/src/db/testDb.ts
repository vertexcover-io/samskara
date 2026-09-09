import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import type { Sql } from "postgres"
import { createDb, type Db } from "./client.js"

export const dockerAvailable = (): boolean => {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

const packageDir = fileURLToPath(new URL("../..", import.meta.url))

/**
 * `db:migrate` is the only supported way to bring a database up to date -- drizzle-kit plus every
 * step in `steps.ts`. Throws on a non-zero exit, which is what lets a test assert that `db:verify`
 * rejects a drifted schema.
 */
export const runDbScript = (
  script: string,
  url: string,
  args: ReadonlyArray<string> = [],
  stdio: "inherit" | "pipe" = "inherit",
): void => {
  execFileSync("bun", ["run", script, ...args], {
    cwd: packageDir,
    env: { ...process.env, DATABASE_URL: url },
    stdio,
  })
}

export type TestDb = {
  readonly db: Db
  readonly client: Sql
  readonly url: string
  readonly teardown: () => Promise<void>
}

export const startTestDb = async (): Promise<TestDb> => {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    "pgvector/pgvector:pg16",
  ).start()
  const url = container.getConnectionUri()
  runDbScript("db:migrate", url)
  const created = createDb(url)
  return {
    db: created.db,
    client: created.client,
    url,
    teardown: async () => {
      await created.client.end()
      await container.stop()
    },
  }
}
