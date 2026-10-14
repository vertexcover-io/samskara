import type { Sql } from "postgres"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest"
import { createDb } from "./client.js"
import {
  filterIndexDefinition,
  normalizeIndexDefinition,
  SEARCH_DOCUMENTS,
  SEARCH_FILTER_INDEXES,
  searchIndexDefinition,
} from "./searchSql.js"
import { MIGRATION_STEPS, runSteps } from "./steps.js"
import { dockerAvailable, runDbScript, startTestDb, type TestDb } from "./testDb.js"

const applySteps = (client: Sql, ...flags: ReadonlyArray<string>): Promise<void> =>
  runSteps(MIGRATION_STEPS, { client, flags: new Set(flags) }, () => undefined)

const staleIndexName = (indexName: string): string => indexName.replace("_v3_idx", "_v2_idx")

const createStaleV2Indexes = async (client: Sql): Promise<void> => {
  for (const document of SEARCH_DOCUMENTS) {
    await client.unsafe(
      `create index concurrently "${staleIndexName(document.indexName)}" on "${document.table}" using gin ((to_tsvector('simple'::regconfig, 'stale')))`,
    )
  }
}

type IndexState = {
  readonly name: string
  readonly ready: boolean
  readonly valid: boolean
  readonly definition: string
}

const indexStates = (
  client: Sql,
  names: ReadonlyArray<string>,
): Promise<ReadonlyArray<IndexState>> =>
  client<ReadonlyArray<IndexState>>`
    select pg_class.relname as name, indisready as ready, indisvalid as valid,
      pg_get_indexdef(indexrelid) as definition
    from pg_index
    join pg_class on pg_class.oid = indexrelid
    where pg_class.relname = any(${names}::text[])
    order by pg_class.relname
  `

const indexNames = async (
  client: Sql,
  names: ReadonlyArray<string>,
): Promise<ReadonlyArray<string>> => (await indexStates(client, names)).map((row) => row.name)

const expectCanonical = (
  rows: ReadonlyArray<IndexState>,
  expected: ReadonlyArray<{ readonly indexName: string; readonly definition: string }>,
): void => {
  expect(rows.map((row) => row.name)).toEqual(expected.map((index) => index.indexName).sort())
  for (const row of rows) {
    expect(row.ready && row.valid).toBe(true)
    const canonical = expected.find((index) => index.indexName === row.name)?.definition ?? ""
    expect(normalizeIndexDefinition(row.definition)).toContain(normalizeIndexDefinition(canonical))
  }
}

describe.skipIf(!dockerAvailable())("search SQL functions and generated columns", () => {
  let teardown: () => Promise<void>
  let url: string

  beforeAll(async () => {
    const started = await startTestDb()
    url = started.url
    teardown = started.teardown
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
})

describe.skipIf(!dockerAvailable())(
  "the planner uses the search indexes on 10,000 sessions",
  () => {
    let started: TestDb

    beforeAll(async () => {
      started = await startTestDb()
      const { client } = started
      const [user] = await client<{ readonly id: string }[]>`
      insert into users ("githubId", "githubLogin") values (900001, 'planner-owner') returning id
    `
      if (user === undefined) throw new Error("planner user was not inserted")
      const [project] = await client<{ readonly id: string }[]>`
      insert into projects (name, slug, "ownerId") values ('Planner', 'planner', ${user.id}) returning id
    `
      if (project === undefined) throw new Error("planner project was not inserted")
      await client`
      insert into sessions (id, source, "userId", "projectId", title, tags)
      select 'planner-' || series, 'claude_code', ${user.id}, ${project.id},
        case when series = 1 then 'planneruniqueneedle' else 'ordinary session ' || series end,
        case when series = 1 then array['needle']::text[] else array['other']::text[] end
      from generate_series(1, 10000) as series
    `
      await client`analyze sessions`
    }, 120_000)

    afterAll(async () => {
      await started?.teardown()
    })

    test.each([
      [
        "a selective keyword",
        `select id from sessions where "searchVector" @@ plainto_tsquery('simple', 'planneruniqueneedle')`,
        "sessions_session_search_v3_idx",
      ],
      [
        "a selective tag filter",
        `select id from sessions where tags && array['needle']::text[]`,
        "sessions_session_filter_tags_v1_idx",
      ],
    ])("%s is answered from its GIN index", async (_case, query, indexName) => {
      const [planRow] = await started.client.unsafe<{ readonly "QUERY PLAN": unknown }[]>(
        `explain (analyze, buffers, format json) ${query}`,
      )
      expect(JSON.stringify(planRow?.["QUERY PLAN"])).toContain(indexName)
    })
  },
)

describe.skipIf(!dockerAvailable())("migration steps converge the search indexes", () => {
  let client: Sql
  let url: string
  let teardown: () => Promise<void>

  beforeEach(async () => {
    const started = await startTestDb()
    client = started.client
    url = started.url
    teardown = started.teardown
  })

  afterEach(async () => {
    await teardown?.()
  })

  test("creates V3 indexes alongside valid stale V2 keyword indexes", async () => {
    await createStaleV2Indexes(client)
    await applySteps(client)

    expectCanonical(
      await indexStates(
        client,
        SEARCH_DOCUMENTS.map((document) => document.indexName),
      ),
      SEARCH_DOCUMENTS.map((document) => ({
        indexName: document.indexName,
        definition: searchIndexDefinition(document),
      })),
    )
    const stale = await indexStates(
      client,
      SEARCH_DOCUMENTS.map((document) => staleIndexName(document.indexName)),
    )
    expect(stale).toHaveLength(SEARCH_DOCUMENTS.length)
    expect(stale.every((row) => row.valid)).toBe(true)
    expectCanonical(
      await indexStates(
        client,
        SEARCH_FILTER_INDEXES.map((index) => index.indexName),
      ),
      SEARCH_FILTER_INDEXES.map((index) => ({
        indexName: index.indexName,
        definition: filterIndexDefinition(index),
      })),
    )
  })

  test("db:migrate --drop-stale removes the stale V2 indexes and leaves the V3 ones in place", async () => {
    await createStaleV2Indexes(client)
    const staleNames = SEARCH_DOCUMENTS.map((document) => staleIndexName(document.indexName))
    expect(await indexNames(client, staleNames)).toHaveLength(SEARCH_DOCUMENTS.length)

    runDbScript("db:migrate", url, ["--drop-stale"], "pipe")

    expect(await indexNames(client, staleNames)).toEqual([])
    expect(
      await indexNames(
        client,
        SEARCH_DOCUMENTS.map((document) => document.indexName),
      ),
    ).toHaveLength(SEARCH_DOCUMENTS.length)
  })

  test("db:verify rejects a searchVector column whose expression drifted from the canonical one", async () => {
    const document = SEARCH_DOCUMENTS.find((candidate) => candidate.table === "pullRequests")
    if (document === undefined) throw new Error("missing pullRequests search document")
    await client.unsafe(`alter table "pullRequests" drop column "searchVector"`)
    await client.unsafe(
      `alter table "pullRequests" add column "searchVector" tsvector generated always as (to_tsvector('simple'::regconfig, 'stale')) stored`,
    )
    await expect(applySteps(client, "verify")).rejects.toThrow(
      /"pullRequests"\."searchVector" does not match its canonical expression/,
    )
    expect(() => runDbScript("db:verify", url, [], "pipe")).toThrow()

    await client.unsafe(`alter table "pullRequests" drop column "searchVector"`)
    await client.unsafe(
      `alter table "pullRequests" add column "searchVector" tsvector generated always as (${document.vector}) stored`,
    )
    await applySteps(client)
    await expect(applySteps(client, "verify")).resolves.toBeUndefined()
  })
})
