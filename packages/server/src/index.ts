import { serve } from "@hono/node-server"
import { buildApp } from "./app.js"
import { createDb } from "./db/client.js"
import { loadEnv } from "./lib/env.js"

const env = loadEnv()
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error("DATABASE_URL is required")

const { db } = createDb(databaseUrl)
const app = buildApp(db, env)

const port = Number(process.env.PORT ?? 3000)

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`samskara server listening on :${info.port}`)
})
