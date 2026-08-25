import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { defineConfig } from "drizzle-kit"

/**
 * Loaded explicitly, and with no hardcoded fallback. The default used to be the main checkout's
 * database, so a worktree that forgot to set DATABASE_URL silently migrated the wrong database --
 * the exact collision per-worktree databases exist to prevent. Missing now fails loudly instead.
 */
const envPath = resolve(process.cwd(), "../../.env")
if (!process.env.DATABASE_URL && existsSync(envPath)) process.loadEnvFile(envPath)

const url = process.env.DATABASE_URL
if (!url) throw new Error("DATABASE_URL is required: set it, or add it to the repo root .env")

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./migrations",
  dbCredentials: { url },
})
