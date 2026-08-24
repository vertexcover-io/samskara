import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { findMigrationViolations, findSchemaViolations, formatViolation } from "../db/naming.js"
import * as schema from "../db/schema.js"

// Migrations before this index predate the camelCase convention (plan decision D4). Migration
// 0017 -- the rename itself -- is exempt too, since its RENAME COLUMN clauses must spell the old
// snake_case names.
const MIGRATION_WATERMARK = 18

const SCHEMA_SOURCE = "packages/server/src/db/schema.ts"
const MIGRATIONS_SOURCE = "packages/server/migrations"

const scriptDir = dirname(fileURLToPath(import.meta.url))
const migrationsDir = join(scriptDir, "../../migrations")

const main = (): void => {
  const lines = [
    ...findSchemaViolations(schema).map((v) => formatViolation(SCHEMA_SOURCE, v)),
    ...findMigrationViolations(migrationsDir, MIGRATION_WATERMARK).map((v) =>
      formatViolation(MIGRATIONS_SOURCE, v),
    ),
  ]

  if (lines.length === 0) {
    console.log("lint:db passed -- every table and column name is camelCase")
    process.exit(0)
  }

  for (const line of lines) console.log(line)
  process.exit(1)
}

main()
