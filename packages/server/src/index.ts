import { serve } from "@hono/node-server"
import { createLogger } from "@samskara/core"
import { buildApp } from "./app.js"
import { createDb } from "./db/client.js"
import { installCrashHandlers } from "./lib/crash-handlers.js"
import { loadEnv } from "./lib/env.js"
import { SHUTDOWN_GRACE_MS } from "./worker/shutdown.js"
import { startWorkerSupervisor } from "./worker/supervisor.js"

const rootLog = createLogger({ service: "samskara-server" })
installCrashHandlers(rootLog)

const env = loadEnv()
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error("DATABASE_URL is required")

const { db } = createDb(databaseUrl)
// Reviews and fix runs run in the worker process; the API only queues them and wakes it.
const worker = startWorkerSupervisor({ log: rootLog.child({ component: "worker" }) })
const app = buildApp(db, env, { rootLog, notifyWorker: worker.notify })
if (env.learningsHarness === undefined)
  rootLog.info(
    "Neither LEARNINGS_HARNESS_REPO nor LEARNINGS_HARNESS_PATH is set, so no automatic fix runs",
  )

const port = Number(process.env.PORT ?? 3000)

const server = serve({ fetch: app.fetch, port }, (info) => {
  rootLog.info({ port: info.port }, "server listening")
})

let shuttingDown = false
const shutdown = (signal: NodeJS.Signals): void => {
  if (shuttingDown) return
  shuttingDown = true
  rootLog.info({ signal }, "shutting down")
  server.close()
  // The worker reaps its own agents and removes their workspaces before it exits. In Docker the
  // server is PID 1 and its exit kills the worker, so wait for that, but not for ever.
  const cap = new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS + 1_000))
  void Promise.race([worker.stop(), cap]).then(() => process.exit(0))
}
process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)
