import type { Sql } from "postgres"
import {
  SEARCH_DOCUMENTS,
  SEARCH_FILTER_INDEXES,
  filterIndexDefinition,
  normalizeIndexDefinition,
  searchIndexDefinition,
} from "./searchSql.js"
import type { MigrationStep } from "./steps.js"

type IndexState = {
  readonly definition: string
  readonly ready: boolean
  readonly valid: boolean
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

const staleNameFor = (indexName: string): string => indexName.replace("_v2_idx", "_v1_idx")

const dropStaleIndex = async (client: Sql, indexName: string): Promise<void> => {
  const staleName = staleNameFor(indexName)
  if ((await stateFor(client, staleName)) !== undefined) {
    await client.unsafe(`drop index concurrently if exists "${staleName}"`)
  }
}

const create = async (client: Sql, dropStale: boolean): Promise<void> => {
  for (const document of SEARCH_DOCUMENTS) {
    await createIndex(client, document.indexName, searchIndexDefinition(document))
    await assertMatches(client, "Search index", document.indexName, document.vector)
  }

  // V1 indexes may be valid but structurally stale. Keep them until every V2 replacement has been
  // built and verified; `--drop-stale` makes their later concurrent cleanup explicit.
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
    await assertMatches(client, "Search index", document.indexName, document.vector)
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
