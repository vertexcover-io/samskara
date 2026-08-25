import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { createDb } from "./client.js"
import {
  filterIndexDefinition,
  normalizeIndexDefinition,
  SEARCH_DOCUMENTS,
  SEARCH_FILTER_INDEXES,
  searchIndexDefinition,
} from "./searchSql.js"

const dockerAvailable = (): boolean => {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

const packageDir = fileURLToPath(new URL("../..", import.meta.url))

describe.skipIf(!dockerAvailable())("session search database foundation", () => {
  let container: StartedPostgreSqlContainer
  let teardown: () => Promise<void>
  let url: string

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start()
    url = container.getConnectionUri()
    execFileSync("bun", ["run", "db:migrate"], {
      cwd: packageDir,
      env: { ...process.env, DATABASE_URL: url },
      stdio: "inherit",
    })
    const created = createDb(url)
    teardown = async () => {
      await created.client.end()
      await container.stop()
    }
  }, 120_000)

  afterAll(async () => {
    await teardown?.()
  })

  test("extracts only JSON string and numeric scalar values in deterministic order", async () => {
    const db = createDb(url)
    try {
      const [row] = await db.client<{ readonly value: string }[]>`
        select public.samskara_search_json_text(
          '{"z":"last","a":[7,true,{"b":"first","a":null}],"ignored":false}'::jsonb
        ) as value
      `
      expect(row?.value).toBe("7\nfirst\nlast")
    } finally {
      await db.client.end()
    }
  })

  test("caps text without retaining a partial final token", async () => {
    const db = createDb(url)
    try {
      const [short] = await db.client<{ readonly value: string }[]>`
        select public.samskara_search_cap(${`${"word ".repeat(6553)}tail`}) as value
      `
      expect(short?.value.endsWith("tail")).toBe(false)
      expect(short?.value.length).toBeLessThanOrEqual(32_768)

      const [hugeToken] = await db.client<{ readonly value: string }[]>`
        select public.samskara_search_cap(${"x".repeat(32_769)}) as value
      `
      expect(hugeToken?.value).toBe("")

      const [atBoundary, overBoundary] = await Promise.all([
        db.client<
          { readonly value: string }[]
        >`select public.samskara_search_cap(${"é ".repeat(16_384)}) as value`,
        db.client<
          { readonly value: string }[]
        >`select public.samskara_search_cap(${`${"é ".repeat(16_383)}ééz`}) as value`,
      ])
      expect(atBoundary[0]?.value).toHaveLength(32_768)
      // The final incomplete token is removed by characters, not UTF-8 bytes.
      expect(overBoundary[0]?.value).toBe("é ".repeat(16_383))
    } finally {
      await db.client.end()
    }
  })

  test("a 2040-character token is dropped before the parser sees it, while a 2039-character neighbour is kept", async () => {
    const db = createDb(url)
    try {
      const monster = "m".repeat(2040)
      const kept = "k".repeat(2039)
      const [row] = await db.client<{ readonly value: string }[]>`
        select public.samskara_search_cap(${`before ${monster} middle ${kept} after`}) as value
      `
      expect(row?.value).not.toContain(monster)
      expect(row?.value).toContain(kept)
      expect(row?.value).toContain("before")
      expect(row?.value).toContain("middle")
      expect(row?.value).toContain("after")
    } finally {
      await db.client.end()
    }
  })

  test("a dropped token does not count against the 32768-character cap, so the text behind it survives", async () => {
    const db = createDb(url)
    try {
      const [row] = await db.client<{ readonly value: string }[]>`
        select public.samskara_search_cap(${`${"m".repeat(3000)} ${"word ".repeat(6000)}tail`}) as value
      `
      expect(row?.value).toContain("tail")
    } finally {
      await db.client.end()
    }
  })

  test("creates V3 indexes alongside valid stale V2 keyword indexes", async () => {
    const stale = createDb(url)
    try {
      for (const document of SEARCH_DOCUMENTS) {
        const staleName = document.indexName.replace("_v3_idx", "_v2_idx")
        const oldExpression = `to_tsvector('simple'::regconfig, 'stale')`
        await stale.client.unsafe(
          `create index concurrently "${staleName}" on "${document.table}" using gin ((${oldExpression}))`,
        )
      }
    } finally {
      await stale.client.end()
    }

    execFileSync("bun", ["run", "db:migrate"], {
      cwd: packageDir,
      env: { ...process.env, DATABASE_URL: url },
      stdio: "inherit",
    })

    const db = createDb(url)
    try {
      const rows = await db.client<
        ReadonlyArray<{ readonly name: string; readonly ready: boolean; readonly valid: boolean }>
      >`
        select pg_class.relname as name, indisready as ready, indisvalid as valid
        from pg_index
        join pg_class on pg_class.oid = indexrelid
        where pg_class.relname = any(${SEARCH_DOCUMENTS.map((document) => document.indexName)}::text[])
        order by pg_class.relname
      `
      expect(rows).toHaveLength(5)
      expect(rows.every((row) => row.ready && row.valid)).toBe(true)
      expect(rows.map((row) => row.name).sort()).toEqual(
        SEARCH_DOCUMENTS.map((document) => document.indexName).sort(),
      )

      const staleRows = await db.client<
        ReadonlyArray<{ readonly name: string; readonly valid: boolean }>
      >`
        select pg_class.relname as name, indisvalid as valid
        from pg_index
        join pg_class on pg_class.oid = indexrelid
        where pg_class.relname = any(${SEARCH_DOCUMENTS.map((document) => document.indexName.replace("_v3_idx", "_v2_idx"))}::text[])
      `
      expect(staleRows).toHaveLength(5)
      expect(staleRows.every((row) => row.valid)).toBe(true)

      const definitions = await db.client<
        ReadonlyArray<{ readonly name: string; readonly definition: string }>
      >`
        select pg_class.relname as name, pg_get_indexdef(indexrelid) as definition
        from pg_index
        join pg_class on pg_class.oid = indexrelid
        where pg_class.relname = any(${SEARCH_DOCUMENTS.map((document) => document.indexName)}::text[])
      `
      for (const document of SEARCH_DOCUMENTS) {
        const definition = definitions.find((row) => row.name === document.indexName)?.definition
        expect(definition).toBeDefined()
        expect(normalizeIndexDefinition(definition ?? "")).toContain(
          normalizeIndexDefinition(searchIndexDefinition(document)),
        )
      }

      const filterRows = await db.client<
        ReadonlyArray<{ readonly name: string; readonly valid: boolean }>
      >`
        select pg_class.relname as name, indisvalid as valid
        from pg_index
        join pg_class on pg_class.oid = indexrelid
        where pg_class.relname = any(${SEARCH_FILTER_INDEXES.map((index) => index.indexName)}::text[])
      `
      expect(filterRows).toHaveLength(SEARCH_FILTER_INDEXES.length)
      expect(filterRows.every((row) => row.valid)).toBe(true)

      const filterDefinitions = await db.client<
        ReadonlyArray<{ readonly name: string; readonly definition: string }>
      >`
        select pg_class.relname as name, pg_get_indexdef(indexrelid) as definition
        from pg_index
        join pg_class on pg_class.oid = indexrelid
        where pg_class.relname = any(${SEARCH_FILTER_INDEXES.map((index) => index.indexName)}::text[])
      `
      for (const index of SEARCH_FILTER_INDEXES) {
        const definition = filterDefinitions.find((row) => row.name === index.indexName)?.definition
        expect(definition).toBeDefined()
        expect(normalizeIndexDefinition(definition ?? "")).toContain(
          normalizeIndexDefinition(filterIndexDefinition(index)),
        )
      }
    } finally {
      await db.client.end()
    }
  }, 120_000)

  test("uses the sessions searchVector GIN index for a selective keyword", async () => {
    const db = createDb(url)
    try {
      const [user] = await db.client<{ readonly id: string }[]>`
        insert into users ("githubId", "githubLogin") values (900001, 'planner-owner') returning id
      `
      if (user === undefined) throw new Error("planner user was not inserted")
      const [project] = await db.client<{ readonly id: string }[]>`
        insert into projects (name, slug, "ownerId") values ('Planner', 'planner', ${user.id}) returning id
      `
      if (project === undefined) throw new Error("planner project was not inserted")
      await db.client`
        insert into sessions (id, source, "userId", "projectId", title)
        select 'planner-' || series, 'claude_code', ${user.id}, ${project.id},
          case when series = 1 then 'planneruniqueneedle' else 'ordinary session ' || series end
        from generate_series(1, 10000) as series
      `
      await db.client`analyze sessions`
      const [planRow] = await db.client.unsafe<{ readonly "QUERY PLAN": unknown }[]>(
        `explain (analyze, buffers, format json) select id from sessions where "searchVector" @@ plainto_tsquery('simple', 'planneruniqueneedle')`,
      )
      const plan = JSON.stringify(planRow?.["QUERY PLAN"])
      expect(plan).toContain("sessions_session_search_v3_idx")
    } finally {
      await db.client.end()
    }
  }, 120_000)

  test("drops stale V2 indexes only after verified V3 creation when requested", async () => {
    execFileSync("bun", ["run", "db:migrate", "--drop-stale"], {
      cwd: packageDir,
      env: { ...process.env, DATABASE_URL: url },
      stdio: "inherit",
    })
    const db = createDb(url)
    try {
      const names = SEARCH_DOCUMENTS.map((document) =>
        document.indexName.replace("_v3_idx", "_v2_idx"),
      )
      const rows = await db.client<ReadonlyArray<{ readonly name: string }>>`
        select pg_class.relname as name
        from pg_index
        join pg_class on pg_class.oid = indexrelid
        where pg_class.relname = any(${names}::text[])
      `
      expect(rows).toEqual([])
    } finally {
      await db.client.end()
    }
  }, 120_000)

  test("every searchable table stores its document in a generated searchVector column with the canonical expression", async () => {
    const db = createDb(url)
    try {
      const rows = await db.client<
        ReadonlyArray<{
          readonly table: string
          readonly expression: string
          readonly generated: string
        }>
      >`
        select c.relname as table, pg_get_expr(d.adbin, d.adrelid) as expression, a.attgenerated as generated
        from pg_attribute a
        join pg_class c on c.oid = a.attrelid
        join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
        where a.attname = 'searchVector'
          and c.relname = any(${SEARCH_DOCUMENTS.map((document) => document.table)}::text[])
      `
      expect(rows.map((row) => row.table).sort()).toEqual(
        SEARCH_DOCUMENTS.map((document) => document.table).sort(),
      )
      for (const document of SEARCH_DOCUMENTS) {
        const row = rows.find((candidate) => candidate.table === document.table)
        expect(row?.generated).toBe("s")
        expect(normalizeIndexDefinition(row?.expression ?? "")).toContain(
          normalizeIndexDefinition(document.vector),
        )
      }
    } finally {
      await db.client.end()
    }
  })

  test("db:verify rejects a searchVector column whose expression drifted from the canonical one", async () => {
    const document = SEARCH_DOCUMENTS.find((candidate) => candidate.table === "pullRequests")
    if (document === undefined) throw new Error("missing pullRequests search document")
    const run = (script: string) =>
      execFileSync("bun", ["run", script], {
        cwd: packageDir,
        env: { ...process.env, DATABASE_URL: url },
        stdio: "pipe",
      })
    const db = createDb(url)
    try {
      await db.client.unsafe(`alter table "pullRequests" drop column "searchVector"`)
      await db.client.unsafe(
        `alter table "pullRequests" add column "searchVector" tsvector generated always as (to_tsvector('simple'::regconfig, 'stale')) stored`,
      )
      expect(() => run("db:verify")).toThrow()

      await db.client.unsafe(`alter table "pullRequests" drop column "searchVector"`)
      await db.client.unsafe(
        `alter table "pullRequests" add column "searchVector" tsvector generated always as (${document.vector}) stored`,
      )
      run("db:migrate")
      expect(() => run("db:verify")).not.toThrow()
    } finally {
      await db.client.end()
    }
  }, 120_000)
})
