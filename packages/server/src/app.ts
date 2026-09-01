import { serveStatic } from "@hono/node-server/serve-static"
import { createLogger } from "@samskara/core"
import { Hono } from "hono"
import type pino from "pino"
import type { Db } from "./db/client.js"
import type { Env } from "./lib/env.js"
import { loggingMiddleware } from "./lib/logging-middleware.js"
import { artifactRoutes } from "./routes/artifacts.js"
import { authRoutes } from "./routes/auth.js"
import { ingestRoutes } from "./routes/ingest.js"
import { orgsRoutes } from "./routes/orgs.js"
import { projectsRoutes } from "./routes/projects.js"
import { sessionsRoutes } from "./routes/sessions.js"
import { syncStatusRoutes } from "./routes/sync-status.js"
import { createGithubClient, type GithubClient } from "./services/github.js"
import { createPairingStore, type PairingStore } from "./services/pairing.js"

type Deps = {
  readonly githubClient?: GithubClient
  readonly pairingStore?: PairingStore
  readonly rootLog?: pino.Logger
}

type Variables = { log: pino.Logger }

export const buildApp = (db: Db, env: Env, deps: Deps = {}) => {
  const githubClient = deps.githubClient ?? createGithubClient(env)
  const pairingStore = deps.pairingStore ?? createPairingStore()
  const rootLog = deps.rootLog ?? createLogger({ service: "samskara-server" })

  const app = new Hono<{ Variables: Variables }>()
    .use(loggingMiddleware(rootLog))
    .get("/health", (c) => c.json({ status: "ok" }, 200))
    .get("/api/health", (c) => c.json({ status: "ok" }, 200))
    .route("/api/auth", authRoutes({ db, env, githubClient, pairingStore }))
    .route("/api/ingest", ingestRoutes({ db, env }))
    .route("/api/artifacts", artifactRoutes({ db, env }))
    .route("/api/orgs", orgsRoutes({ db, env }))
    .route("/api/projects", projectsRoutes({ db, env }))
    .route("/api/sessions", sessionsRoutes({ db, env }))
    .route("/api/sync-status", syncStatusRoutes({ db, env }))

  if (env.webDist) {
    const webDist = env.webDist
    app.use("/*", async (c, next) => {
      if (c.req.path.startsWith("/api/")) return next()
      return serveStatic({ root: webDist })(c, next)
    })
    app.get("*", async (c, next) => {
      if (c.req.path.startsWith("/api/")) return next()
      return serveStatic({ path: `${webDist}/index.html` })(c, next)
    })
  }

  app.onError((err, c) => {
    ;(c.get("log") ?? rootLog).error({ err }, "server error")
    return c.json({ error: "internal" }, 500)
  })

  return app
}

export type AppType = ReturnType<typeof buildApp>
