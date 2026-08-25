import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import * as schema from "./schema.js"

export type Db = ReturnType<typeof drizzle<typeof schema>>

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]

export type Querier = Db | Tx

export const createDb = (url: string) => {
  // Server-side, so the parser's "word is too long to be indexed" notices are never sent.
  const client = postgres(url, { connection: { client_min_messages: "warning" } })
  const db = drizzle(client, { schema })
  return { db, client }
}
