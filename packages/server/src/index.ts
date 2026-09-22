import { serve } from "@hono/node-server"
import { createLogger, terminateHarnessChildren } from "@samskara/core"
import { buildApp } from "./app.js"
import { createDb } from "./db/client.js"
import { installCrashHandlers } from "./lib/crash-handlers.js"
import { loadEnv } from "./lib/env.js"

const rootLog = createLogger({ service: "samskara-server" })
installCrashHandlers(rootLog)

const env = loadEnv()
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error("DATABASE_URL is required")

const { db } = createDb(databaseUrl)
const app = buildApp(db, env, { rootLog })

const port = Number(process.env.PORT ?? 3000)

const server = serve({ fetch: app.fetch, port }, (info) => {
  rootLog.info({ port: info.port }, "server listening")
})

/**
 * Harness children are spawned `detached`, so they survive a signal sent to the server's
 * process group -- including the restart `tsx watch` performs on every server edit. Reaping
 * them here rejects their runner promise, which runs each pipeline's `finally` and removes
 * the workspace holding the staged provider credentials. The brief delay is that cleanup's
 * only chance to run.
 */
const SHUTDOWN_GRACE_MS = 2_000
let shuttingDown = false
const shutdown = (signal: NodeJS.Signals): void => {
  if (shuttingDown) return
  shuttingDown = true
  const reaped = terminateHarnessChildren()
  rootLog.info({ signal, reaped }, "shutting down")
  server.close()
  setTimeout(() => process.exit(0), reaped === 0 ? 0 : SHUTDOWN_GRACE_MS).unref()
}
process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)
