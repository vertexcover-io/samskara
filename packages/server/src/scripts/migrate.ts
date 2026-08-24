import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import postgres from "postgres"
import { MIGRATION_STEPS, runSteps } from "../db/steps.js"

/**
 * The one command that brings a database up to date: drizzle-kit's migrations, then every step in
 * `db/steps.ts` that migrations cannot express. Nothing else may migrate a database -- a setup
 * path that runs only drizzle-kit produces a schema-correct database with no search indexes, which
 * reads as the API hanging rather than as a missing step.
 *
 *   bun run db:migrate                 apply migrations, then converge every step
 *   bun run db:migrate --drop-stale    also drop superseded index versions
 *   bun run db:verify                  read-only: assert every step is already converged
 */
const packageDir = fileURLToPath(new URL("../..", import.meta.url))

// Mirrors drizzle.config.ts: an explicit load with no fallback, so a worktree that forgot to set
// DATABASE_URL fails loudly instead of migrating the main checkout's database.
const envPath = resolve(packageDir, "../../.env")
if (!process.env.DATABASE_URL && existsSync(envPath)) process.loadEnvFile(envPath)

const url = process.env.DATABASE_URL
if (url === undefined || url === "") {
  throw new Error("DATABASE_URL is required: set it, or add it to the repo root .env")
}

const flags: ReadonlySet<string> = new Set(
  process.argv
    .slice(2)
    .filter((argument) => argument.startsWith("--"))
    .map((argument) => argument.slice(2)),
)

// One lock across migrations and steps: two migrates racing would otherwise both start the same
// concurrent index build and leave an invalid index behind.
const LOCK = "samskara:db-migrate"
const client = postgres(url, { max: 1 })

try {
  await client`select pg_advisory_lock(hashtext(${LOCK}))`
  if (!flags.has("verify")) {
    console.log("> migrating schema")
    execFileSync("bun", ["run", "db:migrate:schema"], { cwd: packageDir, stdio: "inherit" })
  }
  await runSteps(MIGRATION_STEPS, { client, flags })
} finally {
  await client`select pg_advisory_unlock(hashtext(${LOCK}))`.catch(() => undefined)
  await client.end()
}
