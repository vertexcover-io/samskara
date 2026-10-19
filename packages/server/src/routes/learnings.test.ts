import { rmSync } from "node:fs"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest"
import { buildApp } from "../app.js"
import type { Db } from "../db/client.js"
import { learningRuns, learnings, reviewProblems, userOrgs, users } from "../db/schema.js"
import { dockerAvailable, startTestDb } from "../db/testDb.js"
import type { Env } from "../lib/env.js"
import { signToken } from "../lib/jwt.js"
import * as learningsRepo from "../repositories/learnings.repo.js"
import {
  fakeAgents,
  harnessRepoFixture,
  problemFixture,
  seedOrg,
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
  let orgId: string
  let orgSlug: string
  let counter = 0

  const request = async (
    path: string,
    init: { method?: string; body?: unknown; as?: string } = {},
  ) => {
    const token = await signToken(env, { sub: init.as ?? userId, aud: "cli" })
    return buildApp(db, env, { aiReviewRunner: agents }).request(path, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
  }

  const seedProblems = async (titles: ReadonlyArray<string>) => {
    counter += 1
    await seedSession(db, {
      sessionId: `route-learn-${counter}`,
      orgId,
      userId,
      problems: titles.map((title) => problemFixture(title)),
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
    orgSlug = `acme-${counter}`
    orgId = await seedOrg(db, orgSlug)
    await db.insert(userOrgs).values({ userId, orgId })
  })

  afterAll(async () => {
    rmSync(harnessPath, { recursive: true, force: true })
    await teardown?.()
  })

  const slug = () => orgSlug

  test("LRT1: a member starts a run with a harness path, and then reads the learnings and their problems", async () => {
    await seedProblems(["A", "B"])
    const started = await request("/api/learnings/runs", {
      method: "POST",
      body: { org: slug(), harnessPath },
    })
    expect(started.status).toBe(202)
    const { runId } = (await started.json()) as { runId: string }
    expect((await waitForRun(runId)).status).toBe("done")

    const list = await request(`/api/learnings?org=${slug()}`)
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
    const res = await request("/api/learnings/runs", { method: "POST", body: { org: slug() } })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "noHarnessPath" })
  })

  test("LRT3: a second run while one is going is a 409", async () => {
    await learningsRepo.startRun(db, orgId)
    const res = await request("/api/learnings/runs", {
      method: "POST",
      body: { org: slug(), harnessPath },
    })
    expect(res.status).toBe(409)
  })

  test("LRT4: someone outside the org sees nothing and cannot start a run", async () => {
    await seedProblems(["A"])
    const run = await learningsRepo.startRun(db, orgId)
    expect((await request(`/api/learnings?org=${slug()}`, { as: strangerId })).status).toBe(404)
    expect((await request(`/api/learnings/runs/${run?.id}`, { as: strangerId })).status).toBe(404)
    const post = await request("/api/learnings/runs", {
      method: "POST",
      body: { org: slug(), harnessPath },
      as: strangerId,
    })
    expect(post.status).toBe(404)
  })
})
