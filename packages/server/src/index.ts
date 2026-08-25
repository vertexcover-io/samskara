import { serve } from "@hono/node-server"
import { createLogger } from "@samskara/core"
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

serve({ fetch: app.fetch, port }, (info) => {
  rootLog.info({ port: info.port }, "server listening")
})
