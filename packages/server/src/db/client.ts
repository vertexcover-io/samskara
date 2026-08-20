import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import * as schema from "./schema.js"

export type Db = ReturnType<typeof drizzle<typeof schema>>

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]

export type Querier = Db | Tx

// Bounds every query on the pool, including the search endpoint's ranking and snippet subqueries
// -- without it, an unbounded `q` can pin a connection on a sequential scan indefinitely.
const STATEMENT_TIMEOUT_MS = 2000

export const createDb = (url: string) => {
  const client = postgres(url, { connection: { statement_timeout: STATEMENT_TIMEOUT_MS } })
  const db = drizzle(client, { schema })
  return { db, client }
}
