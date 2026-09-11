import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import postgres, { type Sql } from "postgres"
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

export const TEST_PG = { adminUrl: "TEST_PG_ADMIN_URL", template: "TEST_PG_TEMPLATE" } as const

export const fromGlobalSetup = (name: (typeof TEST_PG)[keyof typeof TEST_PG]): string => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is unset -- globalSetup did not run`)
  return value
}

const IN_USE = "55006"

let adminClient: Sql | undefined

/**
 * One admin connection per worker, reused by every create and drop. `idle_timeout` is load-bearing:
 * without it the open socket keeps a finished worker from exiting.
 */
const admin = (): Sql => {
  adminClient ??= postgres(fromGlobalSetup(TEST_PG.adminUrl), { max: 1, idle_timeout: 1 })
  return adminClient
}

/** Copying the golden database costs 111 ms; running `db:migrate` again costs 950 ms. */
const createDatabase = async (template: string | null): Promise<string> => {
  const name = `test_${randomUUID().replace(/-/g, "").slice(0, 20)}`
  const clause = template ? ` template "${template}"` : ""
  for (let attempt = 0; ; attempt += 1) {
    try {
      await admin().unsafe(`create database "${name}"${clause}`)
      return name
    } catch (error) {
      // Postgres refuses a template copy while any session is still connected to the template.
      // Nothing here should be, so this covers a socket the server has not yet reaped.
      const code = (error as { readonly code?: string }).code
      if (code !== IN_USE || attempt >= 20) throw error
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
}

const openTestDb = async (template: string | null): Promise<TestDb> => {
  const name = await createDatabase(template)
  const url = new URL(fromGlobalSetup(TEST_PG.adminUrl))
  url.pathname = `/${name}`
  const created = createDb(url.toString())
  return {
    db: created.db,
    client: created.client,
    url: url.toString(),
    teardown: async () => {
      await created.client.end()
      // `with (force)`: a test that leaves a connection open would otherwise fail its own
      // teardown, and the database is being thrown away either way.
      await admin().unsafe(`drop database if exists "${name}" with (force)`)
    },
  }
}

export const startTestDb = (): Promise<TestDb> => openTestDb(fromGlobalSetup(TEST_PG.template))

export const startEmptyTestDb = (): Promise<TestDb> => openTestDb(null)
