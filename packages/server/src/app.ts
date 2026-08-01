import { createLogger } from "@samskara/core"
import { Hono } from "hono"
import type pino from "pino"
import type { Db } from "./db/client.js"
import type { Env } from "./lib/env.js"
import { loggingMiddleware } from "./lib/logging-middleware.js"
import { artifactRoutes } from "./routes/artifacts.js"
import { authRoutes } from "./routes/auth.js"
import { ingestRoutes } from "./routes/ingest.js"
import { projectsRoutes } from "./routes/projects.js"
import { sessionsRoutes } from "./routes/sessions.js"
import { type EmbeddingClient, unconfiguredEmbeddingClient } from "./search/embedding.js"
import { type GithubClient, createGithubClient } from "./services/github.js"
import { type PairingStore, createPairingStore } from "./services/pairing.js"

type Deps = {
  readonly githubClient?: GithubClient
  readonly pairingStore?: PairingStore
  readonly rootLog?: pino.Logger
  readonly embeddingClient?: EmbeddingClient
}

type Variables = { log: pino.Logger }

export const buildApp = (db: Db, env: Env, deps: Deps = {}): Hono<{ Variables: Variables }> => {
  const githubClient = deps.githubClient ?? createGithubClient(env)
  const pairingStore = deps.pairingStore ?? createPairingStore()
  const rootLog = deps.rootLog ?? createLogger({ service: "samskara-server" })
  const embeddingClient = deps.embeddingClient ?? unconfiguredEmbeddingClient
  const app = new Hono<{ Variables: Variables }>()

  app.use(loggingMiddleware(rootLog))

  app.get("/health", (c) => c.json({ status: "ok" }))
  app.route("/api/auth", authRoutes({ db, env, githubClient, pairingStore }))
  app.route("/api/ingest", ingestRoutes({ db, env }))
  app.route("/api/artifacts", artifactRoutes({ db, env }))
  app.route("/api/projects", projectsRoutes({ db, env }))
  app.route("/api/sessions", sessionsRoutes({ db, env, embeddingClient }))

  app.onError((err, c) => {
    ;(c.get("log") ?? rootLog).error({ err }, "server error")
    return c.json({ error: "internal" }, 500)
  })

  return app
}
