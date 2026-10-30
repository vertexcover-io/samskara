import { rmSync } from "node:fs"
import { asc, eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest"
import { buildApp } from "../app.js"
import type { Db } from "../db/client.js"
import {
  learningRuns,
  learnings,
  messages,
  reviewProblems,
  sessions,
  userOrgs,
  users,
} from "../db/schema.js"
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

  /** With `serverHarness`, the server has its own harness checkout (LEARNINGS_HARNESS_PATH). */
  const request = async (
    path: string,
    init: { method?: string; body?: unknown; as?: string; serverHarness?: boolean } = {},
  ) => {
    const token = await signToken(env, { sub: init.as ?? userId, aud: "cli" })
    const appEnv = init.serverHarness ? { ...env, learningsHarness: { path: harnessPath } } : env
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

  test("SC12: the list and the detail return impact and how it helps, null on an older learning", async () => {
    await seedProblems(["A"])
    const started = await request("/api/learnings/runs", {
      method: "POST",
      body: { project: projectId },
      serverHarness: true,
    })
    const { runId } = (await started.json()) as { runId: string }
    expect((await waitForRun(runId)).status).toBe("done")
    const [older] = await db
      .insert(learnings)
      .values({
        projectId,
        updatedByRunId: runId,
        title: "Older one",
        cause: "c",
        problem: "p",
        priority: "low",
        priorityReason: "r",
        fixType: "skill",
        fix: "f",
      })
      .returning()

    const list = (await (await request(`/api/learnings?project=${projectId}`)).json()) as {
      learnings: Array<Record<string, unknown>>
    }
    expect(list.learnings).toEqual([
      expect.objectContaining({
        title: "Helpers report early",
        impact: "time_only",
        impactReason: "lost a few minutes",
        howItHelps: "Saves a few minutes a run.",
      }),
      expect.objectContaining({
        title: "Older one",
        impact: null,
        impactReason: null,
        howItHelps: null,
      }),
    ])
    const detail = (await (await request(`/api/learnings/${list.learnings[0]?.id}`)).json()) as {
      learning: Record<string, unknown>
    }
    expect(detail.learning).toMatchObject({
      impact: "time_only",
      impactReason: "lost a few minutes",
      howItHelps: "Saves a few minutes a run.",
    })
    const old = (await (await request(`/api/learnings/${older?.id}`)).json()) as {
      learning: Record<string, unknown>
    }
    expect(old.learning).toMatchObject({ impact: null, impactReason: null, howItHelps: null })
  })

  test("SC18: the one learning carries each problem's session title and each quote's real message id", async () => {
    await seedSession(db, {
      sessionId: `route-proof-a-${counter}`,
      projectId,
      userId,
      problems: [problemFixture("A", { severity: "high" })],
      texts: ["first message", "waiting on jest"],
    })
    await db
      .update(sessions)
      .set({ title: "Add the search page" })
      .where(eq(sessions.id, `route-proof-a-${counter}`))
    await seedSession(db, {
      sessionId: `route-proof-b-${counter}`,
      projectId,
      userId,
      problems: [problemFixture("B", { severity: "high" })],
    })
    const started = await request("/api/learnings/runs", {
      method: "POST",
      body: { project: projectId },
      serverHarness: true,
    })
    const { runId } = (await started.json()) as { runId: string }
    expect((await waitForRun(runId)).status).toBe("done")
    const [learning] = await learningsRepo.listLearnings(db, projectId)
    const [, second] = await db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.sessionId, `route-proof-a-${counter}`))
      .orderBy(asc(messages.lineNumber))

    const res = await request(`/api/learnings/${learning?.id}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      problems: Array<{ title: string; sessionTitle: string | null; evidence: unknown[] }>
    }
    const byTitle = Object.fromEntries(body.problems.map((p) => [p.title, p]))
    expect(byTitle.A?.sessionTitle).toBe("Add the search page")
    expect(byTitle.A?.evidence).toEqual([
      {
        from: "msg-1",
        to: "msg-1",
        quote: "waiting on jest",
        why: "returned early",
        messageId: second?.id,
      },
    ])
    expect(byTitle.B?.evidence).toEqual([
      {
        from: "msg-1",
        to: "msg-1",
        quote: "waiting on jest",
        why: "returned early",
        messageId: null,
      },
    ])
  })

  test("a session moved to another project after the run shows neither its title nor its message ids", async () => {
    const sessionId = `route-moved-${counter}`
    await seedSession(db, {
      sessionId,
      projectId,
      userId,
      problems: [problemFixture("A", { severity: "high" })],
      texts: ["first message", "waiting on jest"],
    })
    await db
      .update(sessions)
      .set({ title: "Private roadmap work" })
      .where(eq(sessions.id, sessionId))
    const started = await request("/api/learnings/runs", {
      method: "POST",
      body: { project: projectId },
      serverHarness: true,
    })
    const { runId } = (await started.json()) as { runId: string }
    expect((await waitForRun(runId)).status).toBe("done")
    const [learning] = await learningsRepo.listLearnings(db, projectId)
    const elsewhere = await seedProject(db, await seedOrg(db, `private-${counter}`), "private")
    await db.update(sessions).set({ projectId: elsewhere }).where(eq(sessions.id, sessionId))

    const res = await request(`/api/learnings/${learning?.id}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      problems: Array<{ sessionTitle: string | null; evidence: Array<{ messageId: unknown }> }>
    }
    expect(body.problems.map((p) => p.sessionTitle)).toEqual([null])
    expect(body.problems.flatMap((p) => p.evidence.map((item) => item.messageId))).toEqual([null])
  })

  /** One learning whose problem quotes "waiting on jest", the second of the session's messages. */
  const learningWithQuote = async (sessionId: string) => {
    await seedSession(db, {
      sessionId,
      projectId,
      userId,
      problems: [problemFixture("A", { severity: "high" })],
      texts: ["first message", "waiting on jest", "third message", "fourth", "fifth"],
    })
    const started = await request("/api/learnings/runs", {
      method: "POST",
      body: { project: projectId },
      serverHarness: true,
    })
    const { runId } = (await started.json()) as { runId: string }
    expect((await waitForRun(runId)).status).toBe("done")
    const [learning] = await learningsRepo.listLearnings(db, projectId)
    const detail = (await (await request(`/api/learnings/${learning?.id}`)).json()) as {
      problems: Array<{ id: string }>
    }
    return { learningId: learning?.id as string, problemId: detail.problems[0]?.id as string }
  }

  test("a quote's messages are the quoted one and two on each side, the quoted one marked", async () => {
    const { learningId, problemId } = await learningWithQuote(`route-msgs-${counter}`)

    const res = await request(`/api/learnings/${learningId}/messages?problem=${problemId}&quote=0`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      messages: Array<{ id: string; who: string; text: string; cited: boolean }>
    }
    expect(body.messages.map((m) => [m.text, m.cited])).toEqual([
      ["first message", false],
      ["waiting on jest", true],
      ["third message", false],
      ["fourth", false],
    ])
    expect(body.messages[1]?.who).toBe("assistant")
  })

  test("a quote that is not there, or a problem of another fix, is 404", async () => {
    const { learningId, problemId } = await learningWithQuote(`route-msgs-none-${counter}`)

    const noQuote = await request(
      `/api/learnings/${learningId}/messages?problem=${problemId}&quote=5`,
    )
    expect(noQuote.status).toBe(404)
    const otherFix = await request(
      `/api/learnings/${learningId}/messages?problem=${crypto.randomUUID()}&quote=0`,
    )
    expect(otherFix.status).toBe(404)
  })

  test("someone who cannot see the project, or a session moved to another project, gets no messages", async () => {
    const sessionId = `route-msgs-moved-${counter}`
    const { learningId, problemId } = await learningWithQuote(sessionId)
    const path = `/api/learnings/${learningId}/messages?problem=${problemId}&quote=0`

    expect((await request(path, { as: strangerId })).status).toBe(404)
    const elsewhere = await seedProject(db, await seedOrg(db, `msgs-${counter}`), "private")
    await db.update(sessions).set({ projectId: elsewhere }).where(eq(sessions.id, sessionId))
    expect((await request(path)).status).toBe(404)
  })

  test("SC19: someone who cannot see the project gets 404 for one of its learnings", async () => {
    await seedProblems(["A"])
    const started = await request("/api/learnings/runs", {
      method: "POST",
      body: { project: projectId },
      serverHarness: true,
    })
    const { runId } = (await started.json()) as { runId: string }
    expect((await waitForRun(runId)).status).toBe("done")
    const [learning] = await learningsRepo.listLearnings(db, projectId)
    const res = await request(`/api/learnings/${learning?.id}`, { as: strangerId })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "learningNotFound" })
  })

  /** One learning in the project, from a finished run on the server's harness. */
  const oneLearning = async (): Promise<string> => {
    await seedProblems(["A"])
    const started = await request("/api/learnings/runs", {
      method: "POST",
      body: { project: projectId },
      serverHarness: true,
    })
    const { runId } = (await started.json()) as { runId: string }
    expect((await waitForRun(runId)).status).toBe("done")
    const [learning] = await learningsRepo.listLearnings(db, projectId)
    return learning?.id as string
  }

  const newViewer = async (): Promise<string> => {
    const [viewer] = await db
      .insert(users)
      .values({ githubId: 8300 + counter, githubLogin: `skip-viewer-${counter}` })
      .returning()
    await projectsRepo.grant(db, viewer?.id as string, projectId, "viewer")
    return viewer?.id as string
  }

  test("SC29: an editor skips and unskips a fix, and the list shows it skipped with canEdit", async () => {
    const id = await oneLearning()
    const skipped = await request(`/api/learnings/${id}/skip`, { method: "POST" })
    expect(skipped.status).toBe(200)
    const body = (await skipped.json()) as { learning: { skippedAt: string | null } }
    expect(body.learning.skippedAt).toEqual(expect.any(String))

    const list = (await (await request(`/api/learnings?project=${projectId}`)).json()) as {
      learnings: Array<{ id: string; skippedAt: string | null }>
      canEdit: boolean
    }
    expect(list.canEdit).toBe(true)
    expect(list.learnings).toEqual([
      expect.objectContaining({ id, skippedAt: body.learning.skippedAt }),
    ])
    const detail = (await (await request(`/api/learnings/${id}`)).json()) as { canEdit: boolean }
    expect(detail.canEdit).toBe(true)

    const unskipped = await request(`/api/learnings/${id}/skip`, { method: "DELETE" })
    expect(unskipped.status).toBe(200)
    expect(
      ((await unskipped.json()) as { learning: { skippedAt: null } }).learning.skippedAt,
    ).toBeNull()
  })

  test("SC30: a viewer cannot skip or unskip, and the reads say canEdit false", async () => {
    const id = await oneLearning()
    const viewer = await newViewer()
    for (const method of ["POST", "DELETE"]) {
      const res = await request(`/api/learnings/${id}/skip`, { method, as: viewer })
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: "notEditable" })
    }
    const [row] = await db.select().from(learnings)
    expect(row?.skippedAt).toBeNull()
    const list = (await (
      await request(`/api/learnings?project=${projectId}`, { as: viewer })
    ).json()) as { canEdit: boolean }
    expect(list.canEdit).toBe(false)
    const detail = (await (await request(`/api/learnings/${id}`, { as: viewer })).json()) as {
      canEdit: boolean
    }
    expect(detail.canEdit).toBe(false)
  })

  test("SC31: someone who cannot see the project cannot skip its fix", async () => {
    const id = await oneLearning()
    const res = await request(`/api/learnings/${id}/skip`, { method: "POST", as: strangerId })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "learningNotFound" })
    const [row] = await db.select().from(learnings)
    expect(row?.skippedAt).toBeNull()
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
