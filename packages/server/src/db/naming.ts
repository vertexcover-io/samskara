import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { is } from "drizzle-orm"
import { PgTable, getTableConfig } from "drizzle-orm/pg-core"

type Violation = {
  readonly kind: "table" | "column"
  readonly table: string
  readonly name: string
}

const CAMEL_CASE = /^[a-z][a-zA-Z0-9]*$/

export const isCamelCase = (name: string): boolean => CAMEL_CASE.test(name)

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

const sortViolations = (violations: ReadonlyArray<Violation>): Violation[] =>
  [...violations].sort(
    (a, b) => compare(a.table, b.table) || compare(a.kind, b.kind) || compare(a.name, b.name),
  )

export const findSchemaViolations = (schemaModule: Record<string, unknown>): Violation[] => {
  const violations: Violation[] = []

  for (const value of Object.values(schemaModule)) {
    if (!is(value, PgTable)) continue
    const cfg = getTableConfig(value as never)

    if (!isCamelCase(cfg.name)) violations.push({ kind: "table", table: cfg.name, name: cfg.name })

    for (const column of cfg.columns) {
      if (!isCamelCase(column.name)) {
        violations.push({ kind: "column", table: cfg.name, name: column.name })
      }
    }
  }

  return sortViolations(violations)
}

const MIGRATION_INDEX = /^(\d{4})_/
const CREATE_TABLE = /CREATE\s+TABLE\s+"([^"]+)"/gi
const ADD_COLUMN = /ALTER\s+TABLE\s+"([^"]+)"\s+ADD\s+COLUMN\s+"([^"]+)"/gi
const RENAME_TABLE = /ALTER\s+TABLE\s+"([^"]+)"\s+RENAME\s+TO\s+"([^"]+)"/gi
const RENAME_COLUMN = /ALTER\s+TABLE\s+"([^"]+)"\s+RENAME\s+COLUMN\s+"([^"]+)"\s+TO\s+"([^"]+)"/gi

const scanMigrationContent = (content: string): Violation[] => {
  const violations: Violation[] = []

  for (const [, name] of content.matchAll(CREATE_TABLE)) {
    if (name && !isCamelCase(name)) violations.push({ kind: "table", table: name, name })
  }

  for (const [, table, name] of content.matchAll(ADD_COLUMN)) {
    if (table && name && !isCamelCase(name)) violations.push({ kind: "column", table, name })
  }

  for (const [, , name] of content.matchAll(RENAME_TABLE)) {
    if (name && !isCamelCase(name)) violations.push({ kind: "table", table: name, name })
  }

  for (const [, table, , name] of content.matchAll(RENAME_COLUMN)) {
    if (table && name && !isCamelCase(name)) violations.push({ kind: "column", table, name })
  }

  return violations
}

export const findMigrationViolations = (dir: string, fromIndex: number): Violation[] => {
  const violations: Violation[] = []

  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".sql")) continue
    const match = MIGRATION_INDEX.exec(file)
    const index = match?.[1] === undefined ? undefined : Number(match[1])
    if (index === undefined || index < fromIndex) continue
    violations.push(...scanMigrationContent(readFileSync(join(dir, file), "utf-8")))
  }

  return sortViolations(violations)
}
