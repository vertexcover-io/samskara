import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { pgTable, text, uuid } from "drizzle-orm/pg-core"
import { afterEach, describe, expect, test } from "vitest"
import {
  expectedName,
  findMigrationViolations,
  findSchemaViolations,
  formatViolation,
  isCamelCase,
} from "./naming.js"
import * as schema from "./schema.js"

describe("isCamelCase", () => {
  test("S1: accepts camelCase and single lowercase words", () => {
    expect(isCamelCase("id")).toBe(true)
    expect(isCamelCase("sha")).toBe(true)
    expect(isCamelCase("cwd")).toBe(true)
    expect(isCamelCase("githubId")).toBe(true)
    expect(isCamelCase("sourceSchemaVersion")).toBe(true)
  })

  test("S2: rejects snake_case, PascalCase and underscore edges", () => {
    expect(isCamelCase("github_id")).toBe(false)
    expect(isCamelCase("user_orgs")).toBe(false)
    expect(isCamelCase("Users")).toBe(false)
    expect(isCamelCase("_id")).toBe(false)
    expect(isCamelCase("ID")).toBe(false)
  })
})

describe("findSchemaViolations", () => {
  test("S3: a snake_case table name is reported, naming the table", () => {
    const badTable = pgTable("bad_table", { id: uuid("id") })

    expect(findSchemaViolations({ badTable })).toContainEqual({
      kind: "table",
      table: "bad_table",
      name: "bad_table",
    })
  })

  test("S4: a snake_case column is reported, naming table and column", () => {
    const badTable = pgTable("bad_table", { id: uuid("id"), userName: text("user_name") })

    expect(findSchemaViolations({ badTable })).toContainEqual({
      kind: "column",
      table: "bad_table",
      name: "user_name",
    })
  })

  test("S5: a fully camelCase schema reports nothing", () => {
    const goodTable = pgTable("goodTable", { id: uuid("id"), userName: text("userName") })

    expect(findSchemaViolations({ goodTable })).toEqual([])
  })

  test("S10: the live schema reports zero violations", () => {
    expect(findSchemaViolations(schema)).toEqual([])
  })
})

describe("findMigrationViolations", () => {
  const tempDirs: string[] = []

  const writeMigrationDir = (files: Record<string, string>): string => {
    const dir = mkdtempSync(join(tmpdir(), "naming-test-"))
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
    tempDirs.push(dir)
    return dir
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  test("S6: CREATE TABLE and ADD COLUMN snake_case in a scanned migration are reported", () => {
    const dir = writeMigrationDir({
      "0002_bad.sql": [
        'CREATE TABLE "bad_table" (',
        '\t"id" uuid PRIMARY KEY NOT NULL',
        ");",
        "--> statement-breakpoint",
        'ALTER TABLE "bad_table" ADD COLUMN "user_name" text;',
      ].join("\n"),
    })

    expect(findMigrationViolations(dir, 0)).toEqual([
      { kind: "column", table: "bad_table", name: "user_name" },
      { kind: "table", table: "bad_table", name: "bad_table" },
    ])
  })

  test("S7: migrations before the watermark, and RENAME COLUMN sources, are ignored", () => {
    const dir = writeMigrationDir({
      "0001_legacy.sql": [
        'CREATE TABLE "legacy_thing" (',
        '\t"id" uuid PRIMARY KEY NOT NULL',
        ");",
      ].join("\n"),
      "0005_rename.sql": 'ALTER TABLE "users" RENAME COLUMN "github_id" TO "githubId";',
    })

    expect(findMigrationViolations(dir, 3)).toEqual([])
  })

  test("S17: a rename whose target is snake_case is reported, for both a table and a column", () => {
    const dir = writeMigrationDir({
      "0005_rename_back.sql": [
        'ALTER TABLE "goodTable" RENAME TO "bad_table";',
        "--> statement-breakpoint",
        'ALTER TABLE "users" RENAME COLUMN "githubId" TO "github_id";',
      ].join("\n"),
    })

    expect(findMigrationViolations(dir, 3)).toEqual([
      { kind: "table", table: "bad_table", name: "bad_table" },
      { kind: "column", table: "users", name: "github_id" },
    ])
  })
})

const packageDir = fileURLToPath(new URL("../..", import.meta.url))

test("S13: the rename migration renames and never drops a table or column", () => {
  const sql = readFileSync(
    join(packageDir, "migrations", "0017_camelcase_column_rename.sql"),
    "utf-8",
  )

  expect(sql).toMatch(/RENAME COLUMN/)
  expect(sql).not.toMatch(/DROP\s+TABLE|DROP\s+COLUMN/i)
})

// `db:generate` diffs schema.ts against the newest snapshot without touching a database, so an
// empty diff is the only proof the hand-authored snapshot chain matches the hand-authored SQL.
test("S11: db:generate reports no pending changes after the rename migration", () => {
  const result = spawnSync("bun", ["run", "db:generate"], {
    cwd: packageDir,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  })

  expect(result.stdout).toContain("No schema changes")
}, 120_000)

const repoDir = fileURLToPath(new URL("../../../..", import.meta.url))

test("S8: the CLI exits zero on the renamed schema", () => {
  const result = spawnSync("bun", ["run", "src/scripts/lint-db-names.ts"], {
    cwd: packageDir,
    encoding: "utf-8",
  })

  expect(result.status).toBe(0)
  expect(result.stdout).toContain("lint:db passed")
})

// Runs the root `lint` script rather than `lint:db` directly: the bug this guards is the wiring
// falling out of `package.json`, which a direct call to the linter could never catch.
test("S16: `bun run lint` fails and names the column when a snake_case column is added", () => {
  const probe = join(packageDir, "migrations", "9999_lint_probe.sql")
  writeFileSync(probe, 'ALTER TABLE "users" ADD COLUMN "probe_col" text;\n')

  try {
    const result = spawnSync("bun", ["run", "lint"], { cwd: repoDir, encoding: "utf-8" })

    expect(result.status).not.toBe(0)
    expect(result.stdout).toContain("users.probe_col")
  } finally {
    rmSync(probe, { force: true })
  }
}, 120_000)

describe("expectedName", () => {
  test("S18: converts a snake_case name to the camelCase name it should have had", () => {
    expect(expectedName("github_id")).toBe("githubId")
    expect(expectedName("is_super_admin")).toBe("isSuperAdmin")
    expect(expectedName("user_orgs")).toBe("userOrgs")
  })

  test("S18: offers no suggestion when the conversion still would not be camelCase", () => {
    expect(expectedName("USER_ID")).toBeUndefined()
    expect(expectedName("_leading")).toBeUndefined()
    expect(expectedName("Capital_case")).toBeUndefined()
  })
})

describe("formatViolation", () => {
  test("S19: a column violation names table.column and suggests the camelCase name", () => {
    expect(
      formatViolation("schema.ts", { kind: "column", table: "users", name: "github_id" }),
    ).toBe("schema.ts  users.github_id  column name is not camelCase (expected githubId)")
  })

  test("S19: a table violation names the table alone", () => {
    expect(
      formatViolation("schema.ts", { kind: "table", table: "user_orgs", name: "user_orgs" }),
    ).toBe("schema.ts  user_orgs  table name is not camelCase (expected userOrgs)")
  })

  test("S19: the suggestion is omitted when no camelCase name can be derived", () => {
    expect(formatViolation("schema.ts", { kind: "column", table: "users", name: "USER_ID" })).toBe(
      "schema.ts  users.USER_ID  column name is not camelCase",
    )
  })
})
