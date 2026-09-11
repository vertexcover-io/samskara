import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { createDb } from "./client.js"
import { dockerAvailable, runDbScript, TEST_PG } from "./testDb.js"

const GOLDEN = "samskara_test_golden"

let container: StartedPostgreSqlContainer | undefined

/**
 * Returns without starting anything when Docker is absent: a throwing `globalSetup` fails the run
 * before a test executes, which would turn the package's `describe.skipIf(!dockerAvailable())`
 * skips into a hard error.
 */
export const setup = async (): Promise<void> => {
  if (!dockerAvailable()) return

  container = await new PostgreSqlContainer("pgvector/pgvector:pg16")
    .withCommand([
      "postgres",
      "-c",
      "max_connections=500",
      "-c",
      "fsync=off",
      "-c",
      "synchronous_commit=off",
      "-c",
      "full_page_writes=off",
    ])
    .start()

  const adminUrl = container.getConnectionUri()
  const admin = createDb(adminUrl)
  await admin.client.unsafe(`create database "${GOLDEN}"`)
  await admin.client.end()

  const goldenUrl = new URL(adminUrl)
  goldenUrl.pathname = `/${GOLDEN}`
  // Migrating in a subprocess is what makes the copies possible: its connection to the golden
  // database dies with it, and Postgres refuses `create database ... template` while any session
  // is connected to the template.
  runDbScript("db:migrate", goldenUrl.toString())

  process.env[TEST_PG.adminUrl] = adminUrl
  process.env[TEST_PG.template] = GOLDEN
}

export const teardown = async (): Promise<void> => {
  await container?.stop()
}
