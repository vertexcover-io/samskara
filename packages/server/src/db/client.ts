import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import * as schema from "./schema.js"

export type Db = ReturnType<typeof drizzle<typeof schema>>

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]

export type Querier = Db | Tx

// Bounds every query on the pool, including the search endpoint's ranking and snippet subqueries
// -- without it, an unbounded `q` can pin a connection on a sequential scan indefinitely.
const STATEMENT_TIMEOUT_MS = 2000

export type CreateDbOptions = {
  // Postgres treats 0 as "disabled". Admin/DDL connections (e.g. CREATE INDEX CONCURRENTLY, which
  // runs far longer than any request-path query) must opt out of the request-path bound explicitly.
  readonly statementTimeoutMs?: number
}

export const createDb = (url: string, options: CreateDbOptions = {}) => {
  const statementTimeout = options.statementTimeoutMs ?? STATEMENT_TIMEOUT_MS
  const client = postgres(url, { connection: { statement_timeout: statementTimeout } })
  const db = drizzle(client, { schema })
  return { db, client }
}
