import postgres from "postgres"
import {
  filterIndexDefinition,
  normalizeIndexDefinition,
  SEARCH_DOCUMENTS,
  SEARCH_FILTER_INDEXES,
  searchIndexDefinition,
} from "../db/searchSql.js"

type IndexState = {
  readonly definition: string
  readonly ready: boolean
  readonly valid: boolean
}

const url = process.env.DATABASE_URL
if (url === undefined || url === "") throw new Error("DATABASE_URL is required")

const verifyOnly = process.argv.includes("--verify")
const dropStale = process.argv.includes("--drop-stale")
const client = postgres(url, { max: 1 })

const stateFor = async (indexName: string): Promise<IndexState | undefined> => {
  const [row] = await client<ReadonlyArray<IndexState>>`
    select pg_get_indexdef(indexrelid) as definition, indisready as ready, indisvalid as valid
    from pg_index
    where indexrelid = to_regclass(${`"${indexName}"`})
  `
  return row
}

const assertSearchIndex = async (indexName: string, expected: string): Promise<void> => {
  const state = await stateFor(indexName)
  if (state === undefined || !state.ready || !state.valid) {
    throw new Error(`Search index ${indexName} is missing, not ready, or invalid`)
  }

  const actualDefinition = normalizeIndexDefinition(state.definition)
  if (!actualDefinition.includes(normalizeIndexDefinition(expected))) {
    throw new Error(
      `Search index ${indexName} does not match its canonical expression: actual=${actualDefinition}; expected=${normalizeIndexDefinition(expected)}`,
    )
  }
}

const assertFilterIndex = async (indexName: string, expected: string): Promise<void> => {
  const state = await stateFor(indexName)
  if (state === undefined || !state.ready || !state.valid) {
    throw new Error(`Structured filter index ${indexName} is missing, not ready, or invalid`)
  }
  if (!normalizeIndexDefinition(state.definition).includes(normalizeIndexDefinition(expected))) {
    throw new Error(
      `Structured filter index ${indexName} does not match its canonical definition: actual=${normalizeIndexDefinition(state.definition)}; expected=${normalizeIndexDefinition(expected)}`,
    )
  }
}

const dropIfInvalid = async (indexName: string): Promise<void> => {
  const state = await stateFor(indexName)
  if (state !== undefined && (!state.ready || !state.valid)) {
    await client.unsafe(`drop index concurrently if exists "${indexName}"`)
  }
}

const createIndex = async (indexName: string, definition: string): Promise<void> => {
  // A cancelled concurrent build leaves an invalid index behind. Drop it and retry once; a second
  // failure is surfaced rather than spinning indefinitely under the advisory rollout lock.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await dropIfInvalid(indexName)
    if ((await stateFor(indexName)) === undefined) {
      await client.unsafe(definition.replace("create index ", "create index concurrently "))
    }
    const state = await stateFor(indexName)
    if (state?.ready && state.valid) return
  }
  throw new Error(`Concurrent index build for ${indexName} did not become valid`)
}

const staleIndexNameFor = (indexName: string): string => indexName.replace("_v2_idx", "_v1_idx")

const dropStaleIndex = async (indexName: string): Promise<void> => {
  const staleName = staleIndexNameFor(indexName)
  if ((await stateFor(staleName)) !== undefined) {
    await client.unsafe(`drop index concurrently if exists "${staleName}"`)
  }
}

const createIndexes = async (): Promise<void> => {
  for (const document of SEARCH_DOCUMENTS) {
    await createIndex(document.indexName, searchIndexDefinition(document))
    await assertSearchIndex(document.indexName, document.vector)
  }

  // V1 indexes may be valid but structurally stale. Keep them until every V2 replacement has
  // been built and verified; `--drop-stale` makes their later concurrent cleanup explicit.
  if (dropStale) {
    for (const document of SEARCH_DOCUMENTS) await dropStaleIndex(document.indexName)
  }

  for (const index of SEARCH_FILTER_INDEXES) {
    const definition = filterIndexDefinition(index)
    await createIndex(index.indexName, definition)
    await assertFilterIndex(index.indexName, definition)
  }
}

const verifyIndexes = async (): Promise<void> => {
  for (const document of SEARCH_DOCUMENTS) {
    await assertSearchIndex(document.indexName, document.vector)
  }
  for (const index of SEARCH_FILTER_INDEXES) {
    await assertFilterIndex(index.indexName, filterIndexDefinition(index))
  }
}

try {
  await client`select pg_advisory_lock(hashtext('samskara:session-search-indexes:v2'))`
  if (verifyOnly) await verifyIndexes()
  else await createIndexes()
} finally {
  await client`select pg_advisory_unlock(hashtext('samskara:session-search-indexes:v2'))`.catch(
    () => undefined,
  )
  await client.end()
}
