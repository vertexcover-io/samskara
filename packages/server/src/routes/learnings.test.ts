import { rmSync } from "node:fs"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest"
import { buildApp } from "../app.js"
import type { Db } from "../db/client.js"
import { learningRuns, learnings, reviewProblems, userOrgs, users } from "../db/schema.js"
import { dockerAvailable, startTestDb } from "../db/testDb.js"
import type { Env } from "../lib/env.js"
import { signToken } from "../lib/jwt.js"
import * as learningsRepo from "../repositories/learnings.repo.js"
import * as projectsRepo from "../repositories/projects.repo.js"
import {
  fakeAgents,
  harnessRepoFixture,
  problemFixture,
  seedOrg,
  seedProject,
  seedSession,
} from "../services/learnings/testFixtures.js"

const env: Env = {
  githubClientId: "id",
  githubClientSecret: "secret",
  publicBaseUrl: "http://localhost:3000",
  webBaseUrl: "http://localhost:8000",
  cookieSecure: false,
  jwtSecret: "test-secret-value",
  jwtExpiresIn: "7d",
  superAdminLogins: [],
  localLoginSecret: "",
  localLoginLogin: "samskara-dev",
  aiReviewModel: "sonnet",
  aiReviewHarness: "claude",
  aiReviewTimeoutMs: 600000,
}

/** Both agents, faked: one group for everything, written up as one high learning. */
const agents = fakeAgents().runner

describe.skipIf(!dockerAvailable())("learnings routes", () => {
  let db: Db
  let teardown: () => Promise<void>
  let harnessPath: string
  let userId: string
  let strangerId: string
  let projectId: string
  let counter = 0

  /** With `serverHarness`, the server has its own LEARNINGS_HARNESS_PATH. */
  const request = async (
    path: string,
    init: { method?: string; body?: unknown; as?: string; serverHarness?: boolean } = {},
  ) => {
    const token = await signToken(env, { sub: init.as ?? userId, aud: "cli" })
    const appEnv = init.serverHarness ? { ...env, learningsHarnessPath: harnessPath } : env
    return buildApp(db, appEnv, { aiReviewRunner: agents }).request(path, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
  }

  /** High severity, so one session is not a one-off code drops before agent 2. */
  const seedProblems = async (titles: ReadonlyArray<string>) => {
    counter += 1
    await seedSession(db, {
      sessionId: `route-learn-${counter}`,
      projectId,
      userId,
      problems: titles.map((title) => problemFixture(title, { severity: "high" })),
    })
  }

  const waitForRun = async (runId: string) => {
    for (let i = 0; i < 100; i += 1) {
      const res = await request(`/api/learnings/runs/${runId}`)
      const body = (await res.json()) as { run: { status: string; error: string | null } }
      if (body.run.status !== "running") return body.run
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error("run did not finish")
  }

  beforeAll(async () => {
    const started = await startTestDb()
    db = started.db
    teardown = started.teardown
    harnessPath = harnessRepoFixture()
    const [user] = await db
      .insert(users)
      .values({ githubId: 8101, githubLogin: "member" })
      .returning()
    const [stranger] = await db
      .insert(users)
      .values({ githubId: 8102, githubLogin: "stranger" })
      .returning()
    userId = user?.id as string
    strangerId = stranger?.id as string
  }, 120_000)

  beforeEach(async () => {
    await db.delete(reviewProblems)
    await db.delete(learnings)
    await db.delete(learningRuns)
    counter += 1
    const orgId = await seedOrg(db, `acme-${counter}`)
    // An org member is the project's editor: it may read and start runs, not pick a harness.
    await db.insert(userOrgs).values({ userId, orgId })
    projectId = await seedProject(db, orgId, `learn-${counter}`)
  })

  afterAll(async () => {
    rmSync(harnessPath, { recursive: true, force: true })
    await teardown?.()
  })

  test("LRT1: a project admin starts a run with a harness path, and then reads the learnings and their problems", async () => {
    await projectsRepo.grant(db, userId, projectId, "admin")
    await seedProblems(["A", "B"])
    const started = await request("/api/learnings/runs", {
      method: "POST",
      body: { project: projectId, harnessPath },
    })
    expect(started.status).toBe(202)
    const { runId } = (await started.json()) as { runId: string }
    expect((await waitForRun(runId)).status).toBe("done")

    const list = await request(`/api/learnings?project=${projectId}`)
    const body = (await list.json()) as {
      learnings: Array<{
        id: string
        title: string
        priority: string
        problemCount: number
        sessionCount: number
      }>
      latestRun: { id: string; status: string }
    }
    expect(body.latestRun).toMatchObject({ id: runId, status: "done" })
    expect(body.learnings).toEqual([
      expect.objectContaining({
        title: "Helpers report early",
        priority: "high",
        problemCount: 2,
        sessionCount: 1,
      }),
    ])
    const one = await request(`/api/learnings/${body.learnings[0]?.id}`)
    const detail = (await one.json()) as {
      learning: { cause: string }
      problems: Array<{ title: string; sessionId: string }>
    }
    expect(detail.learning.cause).toBe("No wait rule.")
    expect(detail.problems.map((p) => p.title)).toEqual(["A", "B"])
  })

  test("LRT2: without a path in the request or the server's settings, a run is refused", async () => {
    const res = await request("/api/learnings/runs", {
      method: "POST",
      body: { project: projectId },
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "noHarnessPath" })
  })

  test("LRT3: a second run while one is going is a 409", async () => {
    await learningsRepo.startRun(db, projectId)
    const res = await request("/api/learnings/runs", {
      method: "POST",
      body: { project: projectId },
      serverHarness: true,
    })
    expect(res.status).toBe(409)
  })

  test("LRT4: someone who cannot see the project sees nothing and cannot start a run", async () => {
    await seedProblems(["A"])
    const run = await learningsRepo.startRun(db, projectId)
    expect((await request(`/api/learnings?project=${projectId}`, { as: strangerId })).status).toBe(
      404,
    )
    expect((await request(`/api/learnings/runs/${run?.id}`, { as: strangerId })).status).toBe(404)
    const post = await request("/api/learnings/runs", {
      method: "POST",
      body: { project: projectId },
      as: strangerId,
      serverHarness: true,
    })
    expect(post.status).toBe(404)
  })

  test("LRT5: an editor runs on the server's harness, but may not point the server at a path", async () => {
    await seedProblems(["A"])
    const pathPost = await request("/api/learnings/runs", {
      method: "POST",
      body: { project: projectId, harnessPath },
      serverHarness: true,
    })
    expect(pathPost.status).toBe(403)
    expect(await pathPost.json()).toEqual({ error: "harnessPathNeedsAdmin" })
    const started = await request("/api/learnings/runs", {
      method: "POST",
      body: { project: projectId },
      serverHarness: true,
    })
    expect(started.status).toBe(202)
    const { runId } = (await started.json()) as { runId: string }
    expect((await waitForRun(runId)).status).toBe("done")
  })

  test("LRT6: a viewer may read the learnings but not start a run", async () => {
    const [viewer] = await db
      .insert(users)
      .values({ githubId: 8200 + counter, githubLogin: `viewer-${counter}` })
      .returning()
    await projectsRepo.grant(db, viewer?.id as string, projectId, "viewer")
    expect((await request(`/api/learnings?project=${projectId}`, { as: viewer?.id })).status).toBe(
      200,
    )
    const post = await request("/api/learnings/runs", {
      method: "POST",
      body: { project: projectId },
      as: viewer?.id,
      serverHarness: true,
    })
    expect(post.status).toBe(403)
    expect(await post.json()).toEqual({ error: "notEditable" })
  })
})
