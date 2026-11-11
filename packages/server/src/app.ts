import { serveStatic } from "@hono/node-server/serve-static"
import { createLogger } from "@samskara/core"
import { Hono } from "hono"
import type pino from "pino"
import type { Db } from "./db/client.js"
import type { Env } from "./lib/env.js"
import { loggingMiddleware } from "./lib/logging-middleware.js"
import { artifactRoutes } from "./routes/artifacts.js"
import { authRoutes } from "./routes/auth.js"
import { compoundLearningsRoutes } from "./routes/compound-learnings.js"
import { ingestRoutes } from "./routes/ingest.js"
import { learningsRoutes } from "./routes/learnings.js"
import { orgsRoutes } from "./routes/orgs.js"
import { projectsRoutes } from "./routes/projects.js"
import { reviewBatchRoutes } from "./routes/review-batches.js"
import { reviewerOptionsRoutes, reviewRoutes } from "./routes/reviews.js"
import { sessionsRoutes } from "./routes/sessions.js"
import { syncStatusRoutes } from "./routes/sync-status.js"
import { createGithubClient, type GithubClient } from "./services/github.js"
import { createPairingStore, type PairingStore } from "./services/pairing.js"

type Deps = {
  readonly githubClient?: GithubClient
  readonly pairingStore?: PairingStore
  /** Wakes the worker after a row is set to waiting; production is the supervisor's `notify`. */
  readonly notifyWorker?: () => void
  /** Test seam for the reviewer-options availability probe. */
  readonly commandExists?: (command: string) => boolean
  /** Test seam for the credential probe behind the same endpoint. */
  readonly credentialEnv?: NodeJS.ProcessEnv
  readonly rootLog?: pino.Logger
}

type Variables = { log: pino.Logger }

export const buildApp = (db: Db, env: Env, deps: Deps = {}) => {
  const githubClient = deps.githubClient ?? createGithubClient(env)
  const pairingStore = deps.pairingStore ?? createPairingStore()
  const rootLog = deps.rootLog ?? createLogger({ service: "samskara-server" })
  // No agent runs in this process: reviews and fix runs are queued for the worker.
  const notifyWorker = deps.notifyWorker ?? (() => undefined)
  const commandExists = deps.commandExists

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
    // Mounted after sessionsRoutes on the same base: Hono merges, and the `/:id/review`
    // subpaths do not collide with sessionsRoutes' own `/:id` routes.
    .route(
      "/api/sessions",
      reviewRoutes({
        db,
        env,
        notifyWorker,
        ...(deps.credentialEnv === undefined ? {} : { credentialEnv: deps.credentialEnv }),
      }),
    )
    // Its own base: a static /api/sessions/... path would be captured by the `/:id` detail route.
    .route(
      "/api/reviewer-options",
      reviewerOptionsRoutes({ db, env, commandExists, credentialEnv: deps.credentialEnv }),
    )
    .route(
      "/api/review-batches",
      reviewBatchRoutes({
        db,
        env,
        notifyWorker,
        ...(deps.credentialEnv === undefined ? {} : { credentialEnv: deps.credentialEnv }),
      }),
    )
    .route("/api/sync-status", syncStatusRoutes({ db, env }))
    .route("/api/learnings", learningsRoutes({ db, env, notifyWorker }))
    .route("/api/compound-learnings", compoundLearningsRoutes({ db, env }))

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
