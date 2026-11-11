import { fork, spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { createLogger } from "@samskara/core"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import type { Db } from "../db/client.js"
import { projects, sessionReviews, sessions, users } from "../db/schema.js"
import { dockerAvailable, startTestDb } from "../db/testDb.js"
import { queueReview } from "../repositories/workQueue.repo.js"
import { agentGroupsDir, createAgentGroups } from "./agentGroups.js"
import { startWorkerSupervisor, type WorkerChild, type WorkerSupervisor } from "./supervisor.js"

const log = createLogger({ service: "worker-main-test", level: "silent" })
const workerEntry = fileURLToPath(new URL("./main.ts", import.meta.url))

describe.skipIf(!dockerAvailable())("the forked worker", () => {
  let db: Db
  let url: string
  let teardown: () => Promise<void>
  let supervisor: WorkerSupervisor | undefined
  let userId: string
  let projectId: string

  beforeAll(async () => {
    const started = await startTestDb()
    db = started.db
    url = started.url
    teardown = started.teardown
    const [user] = await db
      .insert(users)
      .values({ githubId: 4300, githubLogin: "worker-user" })
      .returning({ id: users.id })
    userId = user?.id as string
    const [project] = await db
      .insert(projects)
      .values({ name: "W", slug: "w", ownerUserId: userId })
      .returning({ id: projects.id })
    projectId = project?.id as string
  }, 120_000)

  afterAll(async () => {
    await supervisor?.stop()
    await teardown?.()
  })

  /** A real worker forked from main.ts under tsx, with an opencode default and no Claude login. */
  const startWorker = async (): Promise<WorkerSupervisor> => {
    // One worker at a time: a new one waits on the advisory lock until the last has exited.
    await supervisor?.stop()
    const workerEnv: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      // A real worker inherits the server's whole env; the agent record lives under its tmpdir.
      TMPDIR: process.env.TMPDIR,
      DATABASE_URL: url,
      PUBLIC_BASE_URL: "http://localhost:3000",
      COOKIE_SECURE: "false",
      JWT_SECRET: "worker-test-secret",
      LOCAL_LOGIN_SECRET: "worker-test-login",
      AI_REVIEW_HARNESS: "opencode",
      OPENCODE_API_KEY: "x",
      LOG_LEVEL: "silent",
    }
    supervisor = startWorkerSupervisor({
      log,
      spawn: () =>
        fork(workerEntry, [], {
          execArgv: ["--import", "tsx"],
          env: workerEnv,
          stdio: "ignore",
        }) as WorkerChild,
    })
    return supervisor
  }

  const seedSession = (id: string) =>
    db.insert(sessions).values({ id, source: "claude_code", userId, projectId })

  /** Waits for the session's review to end failed; Claude has no credential here. */
  const failedReviewOf = async (sessionId: string) => {
    for (let i = 0; i < 100; i += 1) {
      const [row] = await db
        .select()
        .from(sessionReviews)
        .where(eq(sessionReviews.sessionId, sessionId))
      if (row?.status === "failed") return row
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error(`the review of ${sessionId} never ended failed`)
  }

  test("SC21: a real forked worker picks up a queued review on new work", async () => {
    await seedSession("worker-session")
    // Claude has no credential here, so every try is refused before any agent starts.
    await queueReview(db, {
      sessionId: "worker-session",
      projectId,
      analyzer: "ai-problems-v2",
      options: { harness: "claude" },
    })

    const worker = await startWorker()
    worker.notify()

    const row = await failedReviewOf("worker-session")
    expect(row).toMatchObject({ status: "failed", attempts: 3 })
    expect(row.error?.startsWith("harnessUnauthenticated")).toBe(true)
  }, 30_000)

  test("a forked worker that starts picks up a review left running by the worker before it", async () => {
    await seedSession("stranded-session")
    await db.insert(sessionReviews).values({
      sessionId: "stranded-session",
      projectId,
      analyzer: "ai-problems-v2",
      status: "running",
      attempts: 1,
      harness: "claude",
    })

    await startWorker()

    // Requeued, then refused twice more like SC21's: failed on its 3rd try, not stuck at 1.
    const row = await failedReviewOf("stranded-session")
    expect(row).toMatchObject({ status: "failed", attempts: 3 })
    expect(row.error?.startsWith("harnessUnauthenticated")).toBe(true)
  }, 30_000)

  test("a forked worker that starts kills the agent a worker killed with SIGKILL left running", async () => {
    // A stand-in agent, recorded the way the killed worker's runner would have recorded it.
    const orphan = spawn("sleep", ["60"], { detached: true, stdio: "ignore" })
    createAgentGroups(agentGroupsDir(url)).started(orphan.pid as number)
    const gone = new Promise<NodeJS.Signals | null>((resolve) =>
      orphan.once("exit", (_code, signal) => resolve(signal)),
    )

    await startWorker()

    try {
      await expect(gone).resolves.toBe("SIGKILL")
    } finally {
      orphan.kill("SIGKILL")
    }
  }, 30_000)
})
