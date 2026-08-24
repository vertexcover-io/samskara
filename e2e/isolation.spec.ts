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
import { E2E_USER_ID, type SeedSpec, seedDatabase } from "./seed.js"

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

const TWO_PROJECTS: SeedSpec = {
  repositories: [{ key: "own", host: "github.com", owner: "acme", repoName: "own-repo" }],
  projects: [
    {
      slug: "isolation-first",
      name: "Isolation First",
      sessions: [{ id: "22222222-2222-4222-8222-222222222222", title: "First" }],
    },
    {
      slug: "isolation-second",
      name: "Isolation Second",
      sessions: [{ id: "33333333-3333-4333-8333-333333333333", title: "Second" }],
    },
  ],
}

test.describe("SC36 a spec sees only its own rows, whatever the last run left behind", () => {
  test("the wreckage of a crashed capture-pipeline run is gone and the ledger survives", async () => {
    await seedDatabase({ projects: [] })
    const sql = postgres(requireDatabaseUrl(), { max: 1 })
    try {
      const [repo] = await sql<{ id: string }[]>`
        insert into repos (host, owner, repo_name, "userId")
        values ('github.com', 'leftover', 'wreck', ${E2E_USER_ID})
        returning id
      `
      const [project] = await sql<{ id: string }[]>`
        insert into projects (id, name, slug, "ownerId")
        values (gen_random_uuid(), 'Leftover', 'leftover-project', ${E2E_USER_ID})
        returning id
      `
      if (!repo || !project) throw new Error("poison insert returned no row")
      await sql`
        insert into sessions (id, source, "userId", "projectId", title)
        values ('leftover-session', 'claude_code', ${E2E_USER_ID}, ${project.id}, 'Leftover')
      `
      await sql`
        insert into messages (
          "sessionId", "lineUuid", "subIndex", "msgType", "lineNumber", raw,
          "sourceSchemaVersion", "repoId"
        )
        values ('leftover-session', gen_random_uuid(), 0, 'message', 1, '{}'::jsonb, 1, ${repo.id})
      `
      const ledgerBefore = await scalar(sql, LEDGER_COUNT)

      await seedDatabase(TWO_PROJECTS)

      const count = (statement: string) => scalar(sql, statement)
      expect(await count("select count(*) from sessions where id = 'leftover-session'")).toBe(0)
      expect(await count("select count(*) from projects where slug = 'leftover-project'")).toBe(0)

      const slugs = await sql<{ slug: string }[]>`select slug from projects order by slug`
      expect(slugs.map((row) => row.slug)).toEqual(["isolation-first", "isolation-second"])

      const repos = await sql<{ repo_name: string }[]>`select repo_name from repos`
      expect(repos.map((row) => row.repo_name)).toEqual(["own-repo"])

      expect(await scalar(sql, LEDGER_COUNT)).toBe(ledgerBefore)
    } finally {
      await sql.end()
    }
  })
})

test.describe("SC37 seeding the same spec twice leaves the same rows as seeding it once", () => {
  test("the second call raises nothing and lands the same row counts", async () => {
    await seedDatabase(TWO_PROJECTS)
    const sql = postgres(requireDatabaseUrl(), { max: 1 })
    try {
      const first = await rowCounts(sql)
      await seedDatabase(TWO_PROJECTS)
      expect(await rowCounts(sql)).toEqual(first)
    } finally {
      await sql.end()
    }
  })
})

type Sql = ReturnType<typeof postgres>

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

// Drizzle keeps its ledger outside `public`, so a truncate of that schema must leave it whole.
const LEDGER_COUNT = 'select count(*) from drizzle."__drizzle_migrations"'
const COUNTED_TABLES = ["users", "projects", "sessions", "messages", "repos"]

const scalar = async (sql: Sql, statement: string): Promise<number> => {
  const [row] = await sql.unsafe<{ count: string }[]>(statement)
  return Number(row?.count)
}

const rowCounts = async (sql: Sql): Promise<Record<string, number>> => {
  const entries = await Promise.all(
    COUNTED_TABLES.map(
      async (table) => [table, await scalar(sql, `select count(*) from "${table}"`)] as const,
    ),
  )
  return Object.fromEntries(entries)
}
