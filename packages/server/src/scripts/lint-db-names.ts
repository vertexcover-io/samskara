import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { findMigrationViolations, findSchemaViolations, isCamelCase } from "../db/naming.js"
import * as schema from "../db/schema.js"

type Violation = ReturnType<typeof findSchemaViolations>[number]

// Migrations before this index predate the camelCase convention (plan decision D4). Migration
// 0017 -- the rename itself -- is exempt too, since its RENAME COLUMN clauses must spell the old
// snake_case names.
const MIGRATION_WATERMARK = 18

const SCHEMA_SOURCE = "packages/server/src/db/schema.ts"
const MIGRATIONS_SOURCE = "packages/server/migrations"

const scriptDir = dirname(fileURLToPath(import.meta.url))
const migrationsDir = join(scriptDir, "../../migrations")

const expectedName = (name: string): string | undefined => {
  const camel = name.replace(/_([a-zA-Z0-9])/g, (_, char: string) => char.toUpperCase())
  return isCamelCase(camel) ? camel : undefined
}

const formatLine = (source: string, violation: Violation): string => {
  const identifier =
    violation.kind === "table" ? violation.table : `${violation.table}.${violation.name}`
  const label = violation.kind === "table" ? "table name" : "column name"
  const expected = expectedName(violation.name)
  const suffix = expected ? ` (expected ${expected})` : ""

  return `${source}  ${identifier}  ${label} is not camelCase${suffix}`
}

const main = (): void => {
  const lines = [
    ...findSchemaViolations(schema).map((v) => formatLine(SCHEMA_SOURCE, v)),
    ...findMigrationViolations(migrationsDir, MIGRATION_WATERMARK).map((v) =>
      formatLine(MIGRATIONS_SOURCE, v),
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
