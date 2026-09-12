import { fileURLToPath } from "node:url"
import { getTableName, isTable } from "drizzle-orm"
import { readMigrationFiles } from "drizzle-orm/migrator"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { createDb } from "./client.js"
import * as schema from "./schema.js"
import { SEARCH_DOCUMENTS } from "./searchSql.js"
import {
  dockerAvailable,
  fromGlobalSetup,
  runDbScript,
  startEmptyTestDb,
  startTestDb,
  TEST_PG,
  type TestDb,
} from "./testDb.js"

const databaseName = (url: string): string => new URL(url).pathname.slice(1)

const clusterHolds = async (name: string): Promise<boolean> => {
  const admin = createDb(fromGlobalSetup(TEST_PG.adminUrl))
  try {
    const rows = await admin.client`select 1 from pg_database where datname = ${name}`
    return rows.length > 0
  } finally {
    await admin.client.end()
  }
}

describe.skipIf(!dockerAvailable())("startTestDb hands out copies of one migrated database", () => {
  let first: TestDb
  let second: TestDb

  beforeAll(async () => {
    first = await startTestDb()
    second = await startTestDb()
  }, 120_000)

  afterAll(async () => {
    await first?.teardown()
    await second?.teardown()
  })

  test("SC1: two databases from one run carry different names, and an org written to the first is absent from the second", async () => {
    expect(databaseName(first.url)).not.toBe(databaseName(second.url))

    await first.db.insert(schema.orgs).values({ githubSlug: "isolation-probe" })

    expect(await first.db.select().from(schema.orgs)).toHaveLength(1)
    expect(await second.db.select().from(schema.orgs)).toHaveLength(0)
  })

  test("SC2: a copy carries every table schema.ts declares and every search index, and db:verify accepts it", async () => {
    const tables = await second.client<ReadonlyArray<{ readonly tablename: string }>>`
      select tablename from pg_tables where schemaname = 'public' order by tablename
    `
    const declared = Object.values(schema).flatMap((value) =>
      isTable(value) ? [getTableName(value)] : [],
    )
    expect(tables.map((row) => row.tablename)).toEqual(declared.sort())

    const indexes = await second.client<ReadonlyArray<{ readonly indexname: string }>>`
      select indexname from pg_indexes where schemaname = 'public'
    `
    const names = indexes.map((row) => row.indexname)
    for (const document of SEARCH_DOCUMENTS) expect(names).toContain(document.indexName)

    expect(() => runDbScript("db:verify", second.url, [], "pipe")).not.toThrow()
  })

  test("SC3: teardown() drops the database it created", async () => {
    const started = await startTestDb()
    const name = databaseName(started.url)
    try {
      expect(await clusterHolds(name)).toBe(true)
    } finally {
      await started.teardown()
    }

    expect(await clusterHolds(name)).toBe(false)
  }, 120_000)
})

describe.skipIf(!dockerAvailable())("startEmptyTestDb hands out an unmigrated database", () => {
  let empty: TestDb

  beforeAll(async () => {
    empty = await startEmptyTestDb()
  }, 120_000)

  afterAll(async () => {
    await empty?.teardown()
  })

  const publicTables = () =>
    empty.client<ReadonlyArray<{ readonly table_name: string }>>`
      select table_name from information_schema.tables where table_schema = 'public'
    `

  test("SC5: the database holds no table at all, and the first migration's SQL then applies cleanly", async () => {
    expect(await publicTables()).toEqual([])

    const [first] = readMigrationFiles({
      migrationsFolder: fileURLToPath(new URL("../../migrations", import.meta.url)),
    })
    if (!first) throw new Error("the migration journal is empty")
    for (const statement of first.sql) await empty.client.unsafe(statement)

    expect((await publicTables()).map((row) => row.table_name)).toContain("orgs")
  })
})
