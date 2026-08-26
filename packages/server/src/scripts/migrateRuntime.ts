import { fileURLToPath } from "node:url"
import { drizzle } from "drizzle-orm/postgres-js"
import { migrate } from "drizzle-orm/postgres-js/migrator"
import postgres from "postgres"
import { MIGRATION_STEPS, runSteps } from "../db/steps.js"

const packageDir = fileURLToPath(new URL("../..", import.meta.url))
const migrationsFolder = `${packageDir}migrations`

const url = process.env.DATABASE_URL
if (url === undefined || url === "") {
  throw new Error("DATABASE_URL is required")
}

const LOCK = "samskara:db-migrate"
const client = postgres(url, { max: 1 })

try {
  await client`select pg_advisory_lock(hashtext(${LOCK}))`
  console.log("> migrating schema")
  await migrate(drizzle(client), { migrationsFolder })
  await runSteps(MIGRATION_STEPS, { client, flags: new Set() })
  console.log("> database up to date")
} finally {
  await client`select pg_advisory_unlock(hashtext(${LOCK}))`.catch(() => undefined)
  await client.end()
}
