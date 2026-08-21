import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import * as schema from "./schema.js"

export type Db = ReturnType<typeof drizzle<typeof schema>>

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]

export type Querier = Db | Tx

export type DbRuntimeConfig = {
  readonly poolMax: number
  readonly connectTimeoutSeconds: number
  readonly idleTimeoutSeconds: number
  readonly statementTimeoutSeconds: number
}

export const DEFAULT_DB_RUNTIME_CONFIG: DbRuntimeConfig = {
  poolMax: 10,
  connectTimeoutSeconds: 10,
  idleTimeoutSeconds: 30,
  statementTimeoutSeconds: 30,
}

export const createDb = (
  url: string,
  runtimeConfig: DbRuntimeConfig = DEFAULT_DB_RUNTIME_CONFIG,
) => {
  const client = postgres(url, {
    max: runtimeConfig.poolMax,
    connect_timeout: runtimeConfig.connectTimeoutSeconds,
    idle_timeout: runtimeConfig.idleTimeoutSeconds,
    connection: { statement_timeout: runtimeConfig.statementTimeoutSeconds * 1_000 },
  })
  const db = drizzle(client, { schema })
  return { db, client }
}
