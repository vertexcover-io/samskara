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
        >`select public.samskara_search_cap(${"é".repeat(32_768)}) as value`,
        db.client<
          { readonly value: string }[]
        >`select public.samskara_search_cap(${`${"é".repeat(32_768)}z`}) as value`,
      ])
      expect(atBoundary[0]?.value).toHaveLength(32_768)
      // The final incomplete token is removed by characters, not UTF-8 bytes.
      expect(overBoundary[0]?.value).toBe("")
    } finally {
      await db.client.end()
    }
  })

  test("creates V2 indexes alongside valid stale V1 keyword indexes", async () => {
    const stale = createDb(url)
    try {
      for (const document of SEARCH_DOCUMENTS) {
        const staleName = document.indexName.replace("_v2_idx", "_v1_idx")
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
        where pg_class.relname = any(${SEARCH_DOCUMENTS.map((document) => document.indexName.replace("_v2_idx", "_v1_idx"))}::text[])
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

  test("uses the canonical sessions GIN expression index for a selective keyword", async () => {
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
      const vector = SEARCH_DOCUMENTS.find((document) => document.sourceKind === "session")?.vector
      if (vector === undefined) throw new Error("missing sessions search expression")
      const [planRow] = await db.client.unsafe<{ readonly "QUERY PLAN": unknown }[]>(
        `explain (analyze, buffers, format json) select id from sessions where ${vector} @@ plainto_tsquery('simple', 'planneruniqueneedle')`,
      )
      const plan = JSON.stringify(planRow?.["QUERY PLAN"])
      expect(plan).toContain("sessions_session_search_v2_idx")
    } finally {
      await db.client.end()
    }
  }, 120_000)

  test("drops stale V1 indexes only after verified V2 creation when requested", async () => {
    execFileSync("bun", ["run", "db:migrate", "--drop-stale"], {
      cwd: packageDir,
      env: { ...process.env, DATABASE_URL: url },
      stdio: "inherit",
    })
    const db = createDb(url)
    try {
      const names = SEARCH_DOCUMENTS.map((document) =>
        document.indexName.replace("_v2_idx", "_v1_idx"),
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
})
