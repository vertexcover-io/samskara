import { createLogger, terminateHarnessChildren, watchHarnessGroups } from "@samskara/core"
import { createDb } from "../db/client.js"
import { installCrashHandlers } from "../lib/crash-handlers.js"
import { DEFAULT_AI_AGENT_SLOTS, loadEnv } from "../lib/env.js"
import { requeueRunningFixRuns, requeueRunningReviews } from "../repositories/workQueue.repo.js"
import { runAiReview } from "../services/ai-review/pipeline.js"
import { defaultAiReviewRunner } from "../services/ai-review/runner.js"
import { executeLearningRun } from "../services/learnings/run.js"
import { agentGroupsDir, canRecordAgents, createAgentGroups } from "./agentGroups.js"
import { withAgentSlots } from "./agentSlots.js"
import { watchLock } from "./lockWatch.js"
import { createWorkLoop, fixRunner, reviewOptions } from "./loop.js"
import { ALIVE, NEW_WORK, STOP } from "./messages.js"
import { createWorkerShutdown } from "./shutdown.js"

/** The same key on every worker of this database: only one holds it at a time. */
const WORKER_LOCK = "samskara:review-worker"
const ALIVE_EVERY_MS = 30_000
const CHECK_EVERY_MS = 60_000

const log = createLogger({ service: "samskara-worker" })

// Set once the loop exists; a worker stopped while it waits on the lock has no loop to stop.
let stopLoop = (): void => undefined
const shutdown = createWorkerShutdown({
  log,
  stopLoop: () => stopLoop(),
  reap: terminateHarnessChildren,
  exit: (code) => process.exit(code),
})
const stop = shutdown.stop
// A crash goes through the same stop, so its agents are reaped before the worker exits.
installCrashHandlers(log, process, (code) => stop("crash", code))

const send = (message: string): void => {
  if (process.connected) process.send?.(message)
}

// Alive goes out from the start, so a worker waiting on the lock is not taken for a hung one.
send(ALIVE)
setInterval(() => send(ALIVE), ALIVE_EVERY_MS)

// Registered before the lock wait, so a worker still waiting can be stopped.
process.on("message", (message) => {
  if (message === STOP) stop("server asked")
})
// The server is gone (crashed, or `tsx watch` restarted it): a worker never outlives it.
process.on("disconnect", () => stop("server gone"))
process.on("SIGTERM", () => stop("SIGTERM"))
process.on("SIGINT", () => stop("SIGINT"))

const env = loadEnv()
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error("DATABASE_URL is required")
const { db, client } = createDb(databaseUrl)

// A session-level lock lives on one connection, so that connection is reserved for good.
const lockConnection = await client.reserve()
await lockConnection`select pg_advisory_lock(hashtext(${WORKER_LOCK}))`
// Losing that connection loses the lock, and another worker may take it: stop, and let the
// supervisor start one that takes the lock again before it touches the queue.
watchLock({
  check: () => lockConnection`select 1`,
  onLost: (error) => {
    log.error({ err: error }, "worker lock connection lost")
    stop("lock lost", 1)
  },
  everyMs: ALIVE_EVERY_MS,
})

// Agents a worker killed with SIGKILL left behind: past the lock, so their worker is gone.
const agentGroups = createAgentGroups(agentGroupsDir(databaseUrl))
const reapedLeftovers = agentGroups.reapLeftovers()
watchHarnessGroups(agentGroups)
if (!canRecordAgents())
  log.error("`ps` is missing, so agents left by a killed worker cannot be found and reaped")

const requeued = await requeueRunningReviews(db)
const requeuedFixRuns = await requeueRunningFixRuns(db)
log.info({ pid: process.pid, requeued, requeuedFixRuns, reapedLeftovers }, "worker started")

// Every agent call in this process goes through these slots: prompt merge, readers, reviewer and
// fix runs. Wrapped here once: a wrapper per review would give each review its own slots.
const agentSlots = env.aiAgentSlots ?? DEFAULT_AI_AGENT_SLOTS
const runner = withAgentSlots(defaultAiReviewRunner(env, log), agentSlots)
log.info({ agentSlots }, "agent slots")
const loop = createWorkLoop({
  db,
  log,
  runReview: (review) =>
    runAiReview({ db, runner, env, log }, review.sessionId, reviewOptions(review)),
  runFixRun: fixRunner({
    serverHarness: env.learningsHarness,
    execute: (run, harness) =>
      executeLearningRun(
        { db, runner, env, log: log.child({ component: "learnings" }) },
        run.id,
        run.projectId,
        { harness },
      ),
  }),
  // Tied to the server's own harness: without one, every due project would fail 3 times.
  queueDue: env.learningsHarness !== undefined,
  // Reviews run on AI_REVIEW_HARNESS, which the server refuses to boot without.
  nightlyReview: env.nightlyReview,
})

stopLoop = () => {
  loop.stop()
  runner.stop()
}

process.on("message", (message) => {
  if (message === NEW_WORK && !shutdown.isStopping()) void loop.tick()
})
setInterval(() => {
  if (!shutdown.isStopping()) void loop.tick()
}, CHECK_EVERY_MS)
void loop.tick()
