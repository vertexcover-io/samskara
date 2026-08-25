import type { Sql } from "postgres"
import {
  filterIndexDefinition,
  normalizeIndexDefinition,
  SEARCH_DOCUMENTS,
  SEARCH_FILTER_INDEXES,
  SEARCH_VECTOR_COLUMN,
  type SearchDocument,
  searchIndexDefinition,
} from "./searchSql.js"
import type { MigrationStep } from "./steps.js"

type IndexState = {
  readonly definition: string
  readonly ready: boolean
  readonly valid: boolean
}

type ColumnState = {
  readonly expression: string
  readonly generated: string
}

const columnStateFor = async (
  client: Sql,
  table: string,
  column: string,
): Promise<ColumnState | undefined> => {
  const [row] = await client<ReadonlyArray<ColumnState>>`
    select pg_get_expr(d.adbin, d.adrelid) as expression, a.attgenerated as generated
    from pg_attribute a
    join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where a.attrelid = to_regclass(${`"${table}"`}) and a.attname = ${column}
  `
  return row
}

// The column itself comes from a migration; the step only checks it is the one the catalogue
// describes, since an index over a drifted column would silently search the wrong text.
const assertColumnMatches = async (client: Sql, document: SearchDocument): Promise<void> => {
  const label = `Search column "${document.table}"."${SEARCH_VECTOR_COLUMN}"`
  const state = await columnStateFor(client, document.table, SEARCH_VECTOR_COLUMN)
  if (state === undefined || state.generated !== "s") {
    throw new Error(`${label} is missing or is not a stored generated column`)
  }
  const actual = normalizeIndexDefinition(state.expression)
  const expected = normalizeIndexDefinition(document.vector)
  if (!actual.includes(expected)) {
    throw new Error(
      `${label} does not match its canonical expression: actual=${actual}; expected=${expected}`,
    )
  }
}

const stateFor = async (client: Sql, indexName: string): Promise<IndexState | undefined> => {
  const [row] = await client<ReadonlyArray<IndexState>>`
    select pg_get_indexdef(indexrelid) as definition, indisready as ready, indisvalid as valid
    from pg_index
    where indexrelid = to_regclass(${`"${indexName}"`})
  `
  return row
}

const assertMatches = async (
  client: Sql,
  label: string,
  indexName: string,
  expected: string,
): Promise<void> => {
  const state = await stateFor(client, indexName)
  if (state === undefined || !state.ready || !state.valid) {
    throw new Error(`${label} ${indexName} is missing, not ready, or invalid`)
  }
  const actual = normalizeIndexDefinition(state.definition)
  if (!actual.includes(normalizeIndexDefinition(expected))) {
    throw new Error(
      `${label} ${indexName} does not match its canonical definition: actual=${actual}; expected=${normalizeIndexDefinition(expected)}`,
    )
  }
}

const dropIfInvalid = async (client: Sql, indexName: string): Promise<void> => {
  const state = await stateFor(client, indexName)
  if (state !== undefined && (!state.ready || !state.valid)) {
    await client.unsafe(`drop index concurrently if exists "${indexName}"`)
  }
}

const createIndex = async (client: Sql, indexName: string, definition: string): Promise<void> => {
  // A cancelled concurrent build leaves an invalid index behind. Drop it and retry once; a second
  // failure is surfaced rather than spinning indefinitely under the advisory rollout lock.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await dropIfInvalid(client, indexName)
    if ((await stateFor(client, indexName)) === undefined) {
      await client.unsafe(definition.replace("create index ", "create index concurrently "))
    }
    const state = await stateFor(client, indexName)
    if (state?.ready && state.valid) return
  }
  throw new Error(`Concurrent index build for ${indexName} did not become valid`)
}

const staleNameFor = (indexName: string): string => indexName.replace("_v3_idx", "_v2_idx")

const dropStaleIndex = async (client: Sql, indexName: string): Promise<void> => {
  const staleName = staleNameFor(indexName)
  if ((await stateFor(client, staleName)) !== undefined) {
    await client.unsafe(`drop index concurrently if exists "${staleName}"`)
  }
}

const create = async (client: Sql, dropStale: boolean): Promise<void> => {
  for (const document of SEARCH_DOCUMENTS) {
    await assertColumnMatches(client, document)
    await createIndex(client, document.indexName, searchIndexDefinition(document))
    await assertMatches(client, "Search index", document.indexName, searchIndexDefinition(document))
  }

  // V2 expression indexes may be valid but are structurally stale. Keep them until every V3
  // replacement has been built and verified; `--drop-stale` makes their later concurrent cleanup
  // explicit.
  if (dropStale) {
    for (const document of SEARCH_DOCUMENTS) await dropStaleIndex(client, document.indexName)
  }

  for (const index of SEARCH_FILTER_INDEXES) {
    const definition = filterIndexDefinition(index)
    await createIndex(client, index.indexName, definition)
    await assertMatches(client, "Structured filter index", index.indexName, definition)
  }
}

const verify = async (client: Sql): Promise<void> => {
  for (const document of SEARCH_DOCUMENTS) {
    await assertColumnMatches(client, document)
    await assertMatches(client, "Search index", document.indexName, searchIndexDefinition(document))
  }
  for (const index of SEARCH_FILTER_INDEXES) {
    await assertMatches(
      client,
      "Structured filter index",
      index.indexName,
      filterIndexDefinition(index),
    )
  }
}

export const searchIndexStep: MigrationStep = {
  name: "search-indexes",
  run: ({ client, flags }) => create(client, flags.has("drop-stale")),
  verify: ({ client }) => verify(client),
}
