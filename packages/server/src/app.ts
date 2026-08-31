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
import { projectsRoutes } from "./routes/projects.js"
import { learningsRoutes, reviewerOptionsRoutes, reviewRoutes } from "./routes/reviews.js"
import { sessionsRoutes } from "./routes/sessions.js"
import { syncStatusRoutes } from "./routes/sync-status.js"
import { type AiReviewJobRegistry, createAiReviewJobRegistry } from "./services/ai-review/jobs.js"
import {
  createClaudeRunner,
  createMsbWrappedRunner,
  createOpencodeRunner,
  type HarnessRunner,
} from "./services/ai-review/runner.js"
import { createGithubClient, type GithubClient } from "./services/github.js"
import { createPairingStore, type PairingStore } from "./services/pairing.js"

type Deps = {
  readonly githubClient?: GithubClient
  readonly pairingStore?: PairingStore
  readonly aiReviewRunner?: HarnessRunner
  readonly aiReviewJobs?: AiReviewJobRegistry
  /** Test seam for the reviewer-options availability probe. */
  readonly commandExists?: (command: string) => boolean
  readonly rootLog?: pino.Logger
}

type Variables = { log: pino.Logger }

/**
 * Build the production AI-review runner. Which CLI runs the reviewer is a per-run choice
 * (the modal posts `harness` with the analyze request; the pipeline resolves it against the
 * env default), so this builds both lanes once and dispatches on each call:
 *
 * - `opencode` is hard-sandboxed — it runs inside a microsandbox (libkrun microVM) via the
 *   `msb` CLI, with no view of the host filesystem except the bind mounts we hand it, so a
 *   reviewer cannot reach the user's real opencode db or any other session state.
 *   `AI_REVIEW_HARDEN=0` falls back to the in-process runner used in tests.
 * - `claude` always uses the in-process runner (Claude Code reads its credentials from
 *   CLAUDE_CONFIG_DIR, which the runner redirects into the workspace — the msb bootstrap
 *   only knows how to npm-install opencode, so a claude-in-microVM image is separate
 *   future work).
 */
const defaultAiReviewRunner = (env: Env, log: pino.Logger): HarnessRunner => {
  const claude = createClaudeRunner({
    model: env.aiReviewModel,
    timeoutMs: env.aiReviewTimeoutMs,
    log: log.child({ component: "ai-review", harness: "claude" }),
  })
  const opencode: HarnessRunner =
    process.env.AI_REVIEW_HARDEN === "0"
      ? createOpencodeRunner({
          model: env.aiReviewModel,
          timeoutMs: env.aiReviewTimeoutMs,
          log: log.child({ component: "ai-review", sandbox: "soft" }),
        })
      : createMsbWrappedRunner({
          model: env.aiReviewModel,
          timeoutMs: env.aiReviewTimeoutMs,
          log: log.child({ component: "ai-review", sandbox: "msb" }),
          ...(process.env.AI_REVIEW_IMAGE !== undefined
            ? { image: process.env.AI_REVIEW_IMAGE }
            : {}),
          ...(process.env.AI_REVIEW_SNAPSHOT !== undefined
            ? { msbSnapshot: process.env.AI_REVIEW_SNAPSHOT }
            : {}),
          ...(process.env.AI_REVIEW_MEMORY_MB !== undefined
            ? { memoryMb: Number.parseInt(process.env.AI_REVIEW_MEMORY_MB, 10) }
            : {}),
        })
  return {
    run: (input) => (input.harness === "claude" ? claude.run(input) : opencode.run(input)),
  }
}

export const buildApp = (db: Db, env: Env, deps: Deps = {}) => {
  const githubClient = deps.githubClient ?? createGithubClient(env)
  const pairingStore = deps.pairingStore ?? createPairingStore()
  const rootLog = deps.rootLog ?? createLogger({ service: "samskara-server" })
  // The harness bridge and the job registry are built once per app: the model and timeout
  // are env-driven (AI_REVIEW_MODEL / AI_REVIEW_TIMEOUT_MS), and every analyze request shares
  // the one registry so the concurrency cap means something.
  const aiReviewRunner = deps.aiReviewRunner ?? defaultAiReviewRunner(env, rootLog)
  const aiReviewJobs = deps.aiReviewJobs ?? createAiReviewJobRegistry()
  const commandExists = deps.commandExists

  const app = new Hono<{ Variables: Variables }>()
    .use(loggingMiddleware(rootLog))
    .get("/health", (c) => c.json({ status: "ok" }, 200))
    .get("/api/health", (c) => c.json({ status: "ok" }, 200))
    .route("/api/auth", authRoutes({ db, env, githubClient, pairingStore }))
    .route("/api/ingest", ingestRoutes({ db, env }))
    .route("/api/artifacts", artifactRoutes({ db, env }))
    .route("/api/projects", projectsRoutes({ db, env }))
    .route("/api/sessions", sessionsRoutes({ db, env }))
    // Mounted after sessionsRoutes on the same base: Hono merges, and the `/:id/review`
    // subpaths do not collide with sessionsRoutes' own `/:id` routes.
    .route("/api/sessions", reviewRoutes({ db, env, aiReviewRunner, aiReviewJobs }))
    // Its own base: a static /api/sessions/... path would be captured by the `/:id` detail route.
    .route("/api/reviewer-options", reviewerOptionsRoutes({ db, env, commandExists }))
    .route("/api/sync-status", syncStatusRoutes({ db, env }))
    .route("/api/learnings", learningsRoutes({ db, env }))

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
