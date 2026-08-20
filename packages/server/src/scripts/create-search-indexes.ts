import type pino from "pino"
import type postgres from "postgres"
import { createDb } from "../db/client.js"

type IndexDef = { readonly name: string; readonly ddl: string }

const INDEXES: ReadonlyArray<IndexDef> = [
  {
    name: "messages_search_idx_v2",
    ddl: `create index concurrently if not exists messages_search_idx_v2
          on "messages" using gin (msg_search_tsv_v2("content", "details", "msgType"))`,
  },
  {
    name: "sessions_search_idx",
    ddl: `create index concurrently if not exists sessions_search_idx
          on "sessions" using gin (session_search_tsv_v1("title", "cwd"))`,
  },
]

// Postgres does not rebuild an expression index when the function body behind it changes, so
// msg_search_tsv moved to a new _v2 name (see migration 0013) and the index built on the old _v1
// expression is dead weight -- kept around it would just double-write on every message insert.
const LEGACY_INDEXES: ReadonlyArray<string> = ["messages_search_idx"]

// A failed concurrent build leaves an index behind that Postgres will not use.
const dropIfInvalid = async (sql: postgres.Sql, name: string): Promise<void> => {
  const rows = await sql`
    select 1 from pg_class c
    join pg_index i on i.indexrelid = c.oid
    where c.relname = ${name} and not i.indisvalid`
  if (rows.length > 0) await sql.unsafe(`drop index concurrently if exists ${name}`)
}

const indexExists = async (sql: postgres.Sql, name: string): Promise<boolean> => {
  const rows = await sql`select 1 from pg_class where relname = ${name}`
  return rows.length > 0
}

export type IndexBuildResult = { readonly name: string; readonly built: boolean }

export const createSearchIndexes = async (
  sql: postgres.Sql,
): Promise<ReadonlyArray<IndexBuildResult>> => {
  for (const name of LEGACY_INDEXES) {
    await sql.unsafe(`drop index concurrently if exists ${name}`)
  }
  const results: IndexBuildResult[] = []
  for (const index of INDEXES) {
    await dropIfInvalid(sql, index.name)
    const alreadyPresent = await indexExists(sql, index.name)
    await sql.unsafe(index.ddl)
    results.push({ name: index.name, built: !alreadyPresent })
  }
  return results
}

export const findMissingSearchIndexes = async (
  sql: postgres.Sql,
): Promise<ReadonlyArray<string>> => {
  const presence = await Promise.all(
    INDEXES.map(async (index) => ({
      name: index.name,
      exists: await indexExists(sql, index.name),
    })),
  )
  return presence.filter((entry) => !entry.exists).map((entry) => entry.name)
}

export const warnMissingSearchIndexes = async (
  sql: postgres.Sql,
  log: pino.Logger,
): Promise<void> => {
  let missing: ReadonlyArray<string>
  try {
    missing = await findMissingSearchIndexes(sql)
  } catch (error) {
    // A skipped deploy step should cost speed, not correctness -- and a boot-time check must
    // never keep the process from listening, even when the database itself is unreachable.
    log.warn({ error }, "search index check failed; continuing without it")
    return
  }
  for (const name of missing) {
    log.warn(
      { index: name },
      "search index missing; run: bun run --cwd packages/server db:search-index",
    )
  }
}

const main = async (): Promise<void> => {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error("DATABASE_URL is required")
    process.exit(1)
  }
  // CREATE INDEX CONCURRENTLY is a multi-pass DDL statement that runs far longer than the
  // request-path statement_timeout createDb() applies by default -- this admin connection opts out.
  const { client } = createDb(url, { statementTimeoutMs: 0 })
  const results = await createSearchIndexes(client)
  for (const result of results) {
    console.log(`${result.name}: ${result.built ? "built" : "already present"}`)
  }
  await client.end()
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main()
}
