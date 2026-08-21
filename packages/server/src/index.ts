import { serve } from "@hono/node-server"
import { createLogger } from "@samskara/core"
import { buildApp } from "./app.js"
import { createDb } from "./db/client.js"
import { loadEnv } from "./lib/env.js"

const rootLog = createLogger({ service: "samskara-server" })

const env = loadEnv()
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error("DATABASE_URL is required")

const dbConfig = env.db
if (!dbConfig) throw new Error("Database configuration is required")
const { db, client } = createDb(databaseUrl, dbConfig)
const app = buildApp(db, env, { rootLog })

const port = Number(process.env.PORT ?? 3000)
const server = serve({ fetch: app.fetch, port }, (info) => {
  rootLog.info(
    {
      port: info.port,
      dbPoolMax: dbConfig.poolMax,
      dbConnectTimeoutSeconds: dbConfig.connectTimeoutSeconds,
      dbIdleTimeoutSeconds: dbConfig.idleTimeoutSeconds,
      dbStatementTimeoutSeconds: dbConfig.statementTimeoutSeconds,
      serverTiming: env.serverTiming,
    },
    "server listening",
  )
})

let shuttingDown = false
const shutdown = (signal: NodeJS.Signals) => {
  if (shuttingDown) return
  shuttingDown = true
  rootLog.info({ signal }, "server shutting down")
  server.close((error) => {
    void client.end({ timeout: 5 }).then(
      () => {
        if (error) {
          rootLog.error({ err: error }, "server shutdown failed")
          process.exitCode = 1
        }
      },
      (endError: unknown) => {
        rootLog.error({ err: endError }, "database shutdown failed")
        process.exitCode = 1
      },
    )
  })
}

process.once("SIGINT", () => shutdown("SIGINT"))
process.once("SIGTERM", () => shutdown("SIGTERM"))
