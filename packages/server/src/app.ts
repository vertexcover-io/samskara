import { Hono } from "hono"
import type { Db } from "./db/client.js"
import type { Env } from "./lib/env.js"
import { authRoutes } from "./routes/auth.js"
import { ingestRoutes } from "./routes/ingest.js"
import { type GithubClient, createGithubClient } from "./services/github.js"
import { type PairingStore, createPairingStore } from "./services/pairing.js"

type Deps = {
  readonly githubClient?: GithubClient
  readonly pairingStore?: PairingStore
}

export const buildApp = (db: Db, env: Env, deps: Deps = {}): Hono => {
  const githubClient = deps.githubClient ?? createGithubClient(env)
  const pairingStore = deps.pairingStore ?? createPairingStore()
  const app = new Hono()

  app.get("/health", (c) => c.json({ status: "ok" }))
  app.route("/api/auth", authRoutes({ db, env, githubClient, pairingStore }))
  app.route("/api/ingest", ingestRoutes({ db, env }))

  return app
}
