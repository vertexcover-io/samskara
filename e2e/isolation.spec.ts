import { expect, test } from "@playwright/test"
import postgres from "postgres"
import {
  adminUrl,
  createRunDatabase,
  databaseUrlFor,
  dispositionFor,
  dropRunDatabase,
  isRunDatabaseName,
  requireDatabaseUrl,
  runDatabaseName,
  sweepAbandoned,
} from "./db.js"
import { seedDatabase } from "./seed.js"

test.describe("SC30 the database-name guard accepts only names this suite creates", () => {
  test("accepts a name this suite generates", () => {
    expect(isRunDatabaseName("samskara_e2e_4711_9f2ab1")).toBe(true)
    expect(isRunDatabaseName(runDatabaseName())).toBe(true)
  })

  test("rejects the development database, the maintenance database, and near misses", () => {
    expect(isRunDatabaseName("samskara")).toBe(false)
    expect(isRunDatabaseName("postgres")).toBe(false)
    // `_` is a single-character wildcard in `like`, so `samskara_e2e_%` matches this too.
    expect(isRunDatabaseName("samskaraXe2eYdecoy")).toBe(false)
    expect(isRunDatabaseName('samskara_e2e_x"; drop database samskara; --')).toBe(false)
  })
})

test.describe("SC31 a passing run removes its database and a failing run keeps it", () => {
  const url = "postgres://samskara:samskara@localhost:5433/samskara_e2e_1_abcdef"

  test("an exit code of 0 selects removal", () => {
    expect(dispositionFor(0, url)).toEqual({ kind: "drop" })
  })

  test("a non-zero exit code keeps the database and names psql", () => {
    const disposition = dispositionFor(1, url)
    expect(disposition.kind).toBe("keep")
    if (disposition.kind !== "keep") return
    expect(disposition.notice).toContain("psql")
    expect(disposition.notice).toContain(url)
  })
})

test.describe("SC32 the sweep drops abandoned run databases and leaves live ones alone", () => {
  test("drops the unconnected ones, spares the connected one and the development database", async () => {
    const admin = adminUrl()
    const abandoned = [runDatabaseName(), runDatabaseName()]
    for (const name of abandoned) await createRunDatabase(admin, name)

    // Hold a client open on the current run's database: that connection is what marks it live.
    const live = postgres(requireDatabaseUrl(), { max: 1 })
    try {
      await live`select 1`
      const dropped = await sweepAbandoned(admin)

      for (const name of abandoned) expect(dropped).toContain(name)

      const survivors = await databaseNames(admin)
      for (const name of abandoned) expect(survivors).not.toContain(name)
      expect(survivors).toContain("samskara")
      expect(survivors).toContain(currentDatabaseName())
    } finally {
      await live.end()
      for (const name of abandoned) await dropRunDatabase(admin, name)
    }
  })
})

test.describe("SC33 a run works against a migrated database of its own", () => {
  test("DATABASE_URL names a run database that carries the schema and the seeded rows", async () => {
    expect(isRunDatabaseName(currentDatabaseName())).toBe(true)

    await seedDatabase({
      projects: [
        {
          slug: "isolation-check",
          name: "Isolation Check",
          sessions: [{ id: "11111111-1111-4111-8111-111111111111", title: "Isolation session" }],
        },
      ],
    })

    const sql = postgres(requireDatabaseUrl(), { max: 1 })
    try {
      const tables = await sql<{ table_name: string }[]>`
        select table_name from information_schema.tables where table_schema = 'public'
      `
      const names = tables.map((row) => row.table_name)
      for (const table of ["users", "projects", "sessions", "messages", "repos"]) {
        expect(names).toContain(table)
      }

      const [session] = await sql<{ title: string }[]>`
        select title from sessions where id = '11111111-1111-4111-8111-111111111111'
      `
      expect(session?.title).toBe("Isolation session")
    } finally {
      await sql.end()
    }
  })
})

test.describe("SC34 the wrapper names the fix when Postgres is not reachable", () => {
  test("the sweep fails with a message naming bun run stack:up", async () => {
    const closed = "postgres://samskara:samskara@127.0.0.1:5999/postgres"
    await expect(sweepAbandoned(closed)).rejects.toThrow(/bun run stack:up/)
  })
})

const currentDatabaseName = (): string => new URL(requireDatabaseUrl()).pathname.slice(1)

const databaseNames = async (admin: string): Promise<ReadonlyArray<string>> => {
  const sql = postgres(admin, { max: 1 })
  try {
    const rows = await sql<{ datname: string }[]>`select datname from pg_database`
    return rows.map((row) => row.datname)
  } finally {
    await sql.end()
  }
}
