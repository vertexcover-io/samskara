import { serve } from "@hono/node-server"
import { createLogger } from "@samskara/core"
import { buildApp } from "./app.js"
import { createDb } from "./db/client.js"
import { loadEnv } from "./lib/env.js"
import { warnMissingSearchIndexes } from "./scripts/create-search-indexes.js"

const rootLog = createLogger({ service: "samskara-server" })

const env = loadEnv()
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error("DATABASE_URL is required")

const { db, client } = createDb(databaseUrl)
const app = buildApp(db, env, { rootLog })

await warnMissingSearchIndexes(client, rootLog)

const port = Number(process.env.PORT ?? 3000)

serve({ fetch: app.fetch, port }, (info) => {
  rootLog.info({ port: info.port }, "server listening")
})
