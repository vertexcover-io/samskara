import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { type RequestTiming, currentRequestTiming, recordTimingFor } from "../lib/request-timing.js"
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

export type QueryOperation = "select" | "insert" | "update" | "delete" | "transaction" | "other"

export type QueryMetricsSnapshot = {
  readonly activeOperations: number
  readonly activeOperationHighWater: number
  /** postgres-js does not expose a query-to-connection lifecycle, so this is intentionally omitted. */
  readonly poolWaitMs?: undefined
}

export type QueryMetricEvent = {
  readonly operation: QueryOperation
  /** End-to-end application operation time; not a database execution or pool-wait measurement. */
  readonly operationMs: number
  readonly activeOperations: number
  readonly activeOperationHighWater: number
}

export const queryOperationName = (query: string): QueryOperation => {
  const operation = query
    .trimStart()
    .match(/^([a-z]+)/i)?.[1]
    ?.toLowerCase()
  if (
    operation === "select" ||
    operation === "insert" ||
    operation === "update" ||
    operation === "delete"
  ) {
    return operation
  }
  if (
    operation === "begin" ||
    operation === "commit" ||
    operation === "rollback" ||
    operation === "savepoint"
  ) {
    return "transaction"
  }
  return "other"
}

/**
 * An explicit adapter for application-owned DB operations. postgres-js has no public hook that
 * correlates an individual submitted query with connection assignment and completion, so this
 * deliberately measures only operation duration and in-flight pressure. It does not report a
 * pool-wait proxy.
 */
export class QueryMetrics {
  #activeOperations = 0
  #activeOperationHighWater = 0

  async track<T>(
    operation: QueryOperation,
    callback: () => Promise<T>,
    emit?: (event: QueryMetricEvent) => void,
    timing: RequestTiming | undefined = currentRequestTiming(),
  ): Promise<T> {
    const startedAt = performance.now()
    this.#activeOperations += 1
    this.#activeOperationHighWater = Math.max(
      this.#activeOperationHighWater,
      this.#activeOperations,
    )
    try {
      return await callback()
    } finally {
      const operationMs = performance.now() - startedAt
      this.#activeOperations = Math.max(0, this.#activeOperations - 1)
      recordTimingFor(timing, "db.execute", operationMs)
      emit?.({
        operation,
        operationMs: Math.round(operationMs * 100) / 100,
        activeOperations: this.#activeOperations,
        activeOperationHighWater: this.#activeOperationHighWater,
      })
    }
  }

  snapshot(): QueryMetricsSnapshot {
    return {
      activeOperations: this.#activeOperations,
      activeOperationHighWater: this.#activeOperationHighWater,
    }
  }
}

export const createDb = (
  url: string,
  runtimeConfig: DbRuntimeConfig = DEFAULT_DB_RUNTIME_CONFIG,
) => {
  const queryMetrics = new QueryMetrics()
  const client = postgres(url, {
    max: runtimeConfig.poolMax,
    connect_timeout: runtimeConfig.connectTimeoutSeconds,
    idle_timeout: runtimeConfig.idleTimeoutSeconds,
    connection: { statement_timeout: runtimeConfig.statementTimeoutSeconds * 1_000 },
  })
  const db = drizzle(client, { schema })
  return { db, client, queryMetrics }
}
