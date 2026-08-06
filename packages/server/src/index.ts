import { serve } from "@hono/node-server"
import { createLogger } from "@samskara/core"
import { buildApp } from "./app.js"
import { createDb } from "./db/client.js"
import { loadEnv } from "./lib/env.js"
import { resolveEmbeddingClient } from "./search/embedding.js"
import { startEmbeddingWorker } from "./search/worker.js"

const rootLog = createLogger({ service: "samskara-server" })

const env = loadEnv()
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error("DATABASE_URL is required")

const { db } = createDb(databaseUrl)

const embeddingClient = resolveEmbeddingClient(env)

const app = buildApp(db, env, { rootLog, embeddingClient })

if (embeddingClient) {
  startEmbeddingWorker({
    db,
    client: embeddingClient,
    onError: (err) => rootLog.error({ err }, "embedding batch failed"),
  })
  rootLog.info("embedding worker started")
}

const port = Number(process.env.PORT ?? 3000)

serve({ fetch: app.fetch, port }, (info) => {
  rootLog.info({ port: info.port }, "server listening")
})
