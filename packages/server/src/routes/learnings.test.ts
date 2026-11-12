import { rmSync } from "node:fs"
import { createLogger, type HarnessRunner } from "@samskara/core"
import { asc, eq, sql } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest"
import { buildApp } from "../app.js"
import type { Db } from "../db/client.js"
import {
  learningRuns,
  learnings,
  messages,
  reviewProblems,
  sessionReviews,
  sessions,
  userOrgs,
  users,
} from "../db/schema.js"
import { dockerAvailable, startTestDb } from "../db/testDb.js"
import type { Env } from "../lib/env.js"
import { signToken } from "../lib/jwt.js"
import * as learningsRepo from "../repositories/learnings.repo.js"
import * as projectsRepo from "../repositories/projects.repo.js"
import { executeLearningRun } from "../services/learnings/run.js"
import {
  fakeAgents,
  harnessRepoFixture,
  problemFixture,
  STORY_MD,
  seedOrg,
  seedProject,
  seedSession,
} from "../services/learnings/testFixtures.js"
import { createWorkLoop } from "../worker/loop.js"

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
  let notified = 0
  /** The agents the next drained run uses: what the last request named, as the worker would. */
  let agentsForRuns: HarnessRunner = agents

  /** With `serverHarness`, the server has its own harness checkout (LEARNINGS_HARNESS_PATH). */
  const request = async (
    path: string,
    init: {
      method?: string
      body?: unknown
      as?: string
      serverHarness?: boolean
      runner?: HarnessRunner
    } = {},
  ) => {
    const token = await signToken(env, { sub: init.as ?? userId, aud: "cli" })
    const appEnv = init.serverHarness ? { ...env, learningsHarness: { path: harnessPath } } : env
    agentsForRuns = init.runner ?? agents
    return buildApp(db, appEnv, {
      notifyWorker: () => {
        notified += 1
      },
    }).request(path, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
  }

  /** High severity, so one session is not a one-off code drops before agent 2. */
  /** A session with these problems; with `withRecords` (the default) its messages too, so its evidence can be quoted. */
  const seedProblems = async (titles: ReadonlyArray<string>, withRecords = true) => {
    counter += 1
    await seedSession(db, {
      sessionId: `route-learn-${counter}`,
      projectId,
      userId,
      problems: titles.map((title) => problemFixture(title, { severity: "high" })),
      ...(withRecords ? { texts: ["first message", "waiting on jest"] } : {}),
    })
  }

  /** Runs what is queued the way the worker does, then reads the run back through the route. */
  const waitForRun = async (runId: string) => {
    const runner = agentsForRuns
    const log = createLogger({ service: "learnings-route-test", level: "silent" })
    const loop = createWorkLoop({
      db,
      log,
      runReview: async () => {
        throw new Error("no review is queued in these tests")
      },
      runFixRun: (run) =>
        executeLearningRun({ db, runner, env, log }, run.id, run.projectId, {
          harness: { path: run.harnessPath ?? harnessPath },
        }),
    })
    await loop.tick()
    await loop.idle()
    const res = await request(`/api/learnings/runs/${runId}`)
    return ((await res.json()) as { run: { status: string; error: string | null } }).run
  }

  const DAY = 24 * 60 * 60 * 1000
  const daysAgo = (days: number) => new Date(Date.now() - days * DAY)

  /**
   * A fix written straight to the tables, with one session per entry of `seen`: each session is
   * active at that instant and holds `problems` problems (1 by default) linked to the fix.
   */
  const seedFix = async (
    title: string,
    seen: ReadonlyArray<{ readonly at: Date; readonly problems?: number }>,
    options: { readonly fixType?: string; readonly priority?: string } = {},
  ) => {
    const run = await learningsRepo.startRun(db, projectId)
    if (run === null) throw new Error("a run is already going")
    await learningsRepo.finishRun(db, run.id, { status: "done" })
    const [fix] = await db
      .insert(learnings)
      .values({
        projectId,
        updatedByRunId: run.id,
        title,
        cause: "c",
        problem: "p",
        priority: options.priority ?? "high",
        priorityReason: "r",
        fixType: options.fixType ?? "skill",
        fix: "f",
      })
      .returning()
    for (const entry of seen) {
      counter += 1
      const sessionId = `route-seen-${counter}`
      await seedSession(db, {
        sessionId,
        projectId,
        userId,
        problems: Array.from({ length: entry.problems ?? 1 }, (_, index) =>
          problemFixture(`${title} ${index}`),
        ),
      })
      await db.update(sessions).set({ lastMessageAt: entry.at }).where(eq(sessions.id, sessionId))
      await db
        .update(reviewProblems)
        .set({ learningId: fix?.id as string, learningRunId: run.id })
        .where(eq(reviewProblems.sessionId, sessionId))
    }
    return fix?.id as string
  }

  type Listed = {
    title: string
    problemCount: number
    sessionCount: number
    firstSeenAt: string | null
    lastSeenAt: string | null
    sessionsLast7Days: number
  }
  const listed = async (query: string) => {
    const res = await request(`/api/learnings?project=${projectId}${query}`)
    return { status: res.status, body: (await res.json()) as { learnings: Listed[] } }
  }
  const titles = async (query: string) =>
    (await listed(query)).body.learnings.map((row) => row.title)

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
    notified = 0
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

  test("LRT1: a project admin starts a run with a harness path, and then reads the learnings, each naming its project, and their problems", async () => {
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
        projectId,
      }),
    ])
    const one = await request(`/api/learnings/${body.learnings[0]?.id}`)
    const detail = (await one.json()) as {
      learning: { cause: string; projectId: string }
      problems: Array<{ title: string; sessionId: string }>
    }
    expect(detail.learning.cause).toBe("No wait rule.")
    expect(detail.learning.projectId).toBe(projectId)
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
        fixSummary: "Make the agent wait before it reports.",
      }),
      expect.objectContaining({
        title: "Older one",
        impact: null,
        impactReason: null,
        howItHelps: null,
        fixSummary: null,
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

  /** Runs a learning run on the server's harness with `runner`, and returns the run's id. */
  const runWith = async (runner: HarnessRunner = agents) => {
    const started = await request("/api/learnings/runs", {
      method: "POST",
      body: { project: projectId },
      serverHarness: true,
      runner,
    })
    const { runId } = (await started.json()) as { runId: string }
    expect((await waitForRun(runId)).status).toBe("done")
    return runId
  }
  type Story = {
    steps: Array<{ text: string; quote: string }>
    whyProblem: string
    shouldHave: string
  }
  const listOf = async () =>
    (
      (await (await request(`/api/learnings?project=${projectId}`)).json()) as {
        learnings: Array<{ id: string; title: string; story: Story | null }>
      }
    ).learnings
  const storyOf = async (id: string | undefined) =>
    (
      (await (await request(`/api/learnings/${id}`)).json()) as {
        learning: { story: Story | null }
      }
    ).learning.story
  const insertOlder = async (runId: string) => {
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
    return older?.id
  }

  test("SC301: a learning run saves the writer's story, and the fix's page returns it step by step", async () => {
    await seedProblems(["A"])
    await runWith()
    const [learning] = await listOf()
    expect(await storyOf(learning?.id)).toEqual({
      steps: [
        { text: "The helper started the tests.", quote: "waiting on jest" },
        { text: "It reported before they finished.", quote: "waiting on jest" },
        { text: "The main agent took that as done.", quote: "waiting on jest" },
      ],
      whyProblem: "Nobody saw the tests pass.",
      shouldHave: "It should have waited for the tests.",
    })
  })

  test("SC302: a fix saved before the story was asked for returns story null on the list and its page", async () => {
    await seedProblems(["A"])
    const older = await insertOlder(await runWith())
    const list = await listOf()
    expect(list.find((learning) => learning.id === older)?.story).toBeNull()
    expect(await storyOf(older)).toBeNull()
  })

  test("SC303: a stored story that does not fit the shape is returned as null, not as raw data", async () => {
    await seedProblems(["A"])
    const older = await insertOlder(await runWith())
    await db.execute(sql`update learnings set story = '{"steps": []}'::jsonb where id = ${older}`)
    expect(await storyOf(older)).toBeNull()
  })

  test("SC305: a run whose sessions show no records to quote still finishes, and saves no story", async () => {
    await seedProblems(["A"], false)
    await runWith()
    const [learning] = await listOf()
    expect(learning?.title).toBe("Helpers report early")
    expect(await storyOf(learning?.id)).toBeNull()
  })

  test("SC304: a run that updates a fix replaces its story, and it stays one fix", async () => {
    await seedProblems(["A"])
    await runWith()
    await seedProblems(["B"])
    await runWith(
      fakeAgents({
        story: STORY_MD.replace("The helper started the tests.", "Again it reported early."),
      }).runner,
    )
    const list = await listOf()
    expect(list).toHaveLength(1)
    expect((await storyOf(list[0]?.id))?.steps[0]?.text).toBe("Again it reported early.")
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

  const runRows = () => db.select().from(learningRuns).where(eq(learningRuns.projectId, projectId))

  test("SC42: Run now queues a run that waits for reviews by default", async () => {
    await seedProblems(["A"])
    const finished = await learningsRepo.startRun(db, projectId)
    await learningsRepo.finishRun(db, finished?.id as string, { status: "done" })
    let agentRuns = 0
    const res = await request("/api/learnings/runs", {
      method: "POST",
      body: { project: projectId },
      serverHarness: true,
      runner: {
        run: async (input) => {
          agentRuns += 1
          return agents.run(input)
        },
      },
    })

    expect(res.status).toBe(202)
    const { runId } = (await res.json()) as { runId: string }
    const [row] = (await runRows()).filter((run) => run.id === runId)
    expect(row).toMatchObject({ status: "waiting", waitForReviews: true, harnessPath: null })
    expect(notified).toBe(1)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(agentRuns).toBe(0)
  })

  test("SC43: Run now with waitForReviews false queues a run that starts at once", async () => {
    const res = await request("/api/learnings/runs", {
      method: "POST",
      body: { project: projectId, waitForReviews: false },
      serverHarness: true,
    })

    expect(res.status).toBe(202)
    const [row] = await runRows()
    expect(row).toMatchObject({ status: "waiting", waitForReviews: false })
  })

  test("SC44: Run now reuses the waiting run and takes the caller's choice", async () => {
    const [automatic] = await db
      .insert(learningRuns)
      .values({ projectId, status: "waiting", waitForReviews: true })
      .returning()

    const res = await request("/api/learnings/runs", {
      method: "POST",
      body: { project: projectId, waitForReviews: false },
      serverHarness: true,
    })

    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ runId: automatic?.id })
    const rows = await runRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: "waiting", waitForReviews: false })
  })

  test("SC45/SC733: Run now refused while a run is running names that run", async () => {
    const running = await learningsRepo.startRun(db, projectId)
    const res = await request("/api/learnings/runs", {
      method: "POST",
      body: { project: projectId },
      serverHarness: true,
    })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      error: "learningRunAlreadyRunning",
      runId: running?.id,
    })
    expect(notified).toBe(0)
  })

  test("SC46: Run now still refuses viewers and a non-admin's harness path, writing no row", async () => {
    const [viewer] = await db
      .insert(users)
      .values({ githubId: 8300 + counter, githubLogin: `sc46-viewer-${counter}` })
      .returning()
    await projectsRepo.grant(db, viewer?.id as string, projectId, "viewer")
    const asViewer = await request("/api/learnings/runs", {
      method: "POST",
      body: { project: projectId },
      as: viewer?.id,
      serverHarness: true,
    })
    expect(asViewer.status).toBe(403)
    expect(await asViewer.json()).toEqual({ error: "notEditable" })
    const withPath = await request("/api/learnings/runs", {
      method: "POST",
      body: { project: projectId, harnessPath },
      serverHarness: true,
    })
    expect(withPath.status).toBe(403)
    expect(await withPath.json()).toEqual({ error: "harnessPathNeedsAdmin" })
    expect(await runRows()).toEqual([])
    expect(notified).toBe(0)
  })

  test("SC714: type keeps only that fix type's fixes, no type keeps them all, and an unknown type is a 400", async () => {
    await seedFix("Skill fix", [{ at: daysAgo(1) }], { fixType: "skill" })
    await seedFix("Code fix", [{ at: daysAgo(1) }], { fixType: "code", priority: "low" })

    expect(await titles("&type=skill")).toEqual(["Skill fix"])
    expect(await titles("")).toEqual(["Skill fix", "Code fix"])
    expect((await listed("&type=bogus")).status).toBe(400)
  })

  test("SC715: from and to keep fixes with a session active between them, still counting all their problems", async () => {
    await seedFix("Fix A", [
      { at: new Date("2026-11-02T12:00:00Z") },
      { at: new Date("2026-11-20T12:00:00Z") },
    ])
    await seedFix("Fix B", [{ at: new Date("2026-10-01T12:00:00Z") }], { priority: "low" })

    const window = await listed("&from=2026-11-01T00:00:00Z&to=2026-11-10T00:00:00Z")
    expect(
      window.body.learnings.map((row) => [row.title, row.problemCount, row.sessionCount]),
    ).toEqual([["Fix A", 2, 2]])
    expect(await titles("&from=2026-11-01T00:00:00Z")).toEqual(["Fix A"])
    expect(await titles("&to=2026-10-02T00:00:00Z")).toEqual(["Fix B"])
    expect((await listed("&from=not-a-date")).status).toBe(400)
  })

  test("SC716: each fix carries its first and last seen dates and how many of its sessions were active in the last 7 days", async () => {
    const twentyDays = daysAgo(20)
    const twoDays = daysAgo(2)
    await seedFix("Seen fix", [
      { at: daysAgo(3) },
      { at: twoDays, problems: 2 },
      { at: twentyDays },
    ])
    const orphanId = await seedFix("Orphan fix", [{ at: daysAgo(1) }], { priority: "low" })
    await db
      .update(reviewProblems)
      .set({ learningId: null })
      .where(eq(reviewProblems.learningId, orphanId))

    const { body } = await listed("")
    expect(body.learnings).toEqual([
      expect.objectContaining({
        title: "Seen fix",
        firstSeenAt: twentyDays.toISOString(),
        lastSeenAt: twoDays.toISOString(),
        sessionsLast7Days: 2,
      }),
      expect.objectContaining({
        title: "Orphan fix",
        firstSeenAt: null,
        lastSeenAt: null,
        sessionsLast7Days: 0,
      }),
    ])
  })

  test("a session moved to another project no longer sets a fix's seen dates or matches its date filter, though it still counts", async () => {
    const moved = daysAgo(2)
    const stayed = daysAgo(30)
    await seedFix("Moved fix", [{ at: stayed }, { at: moved }])
    const elsewhere = await seedProject(
      db,
      await seedOrg(db, `elsewhere-${counter}`),
      `elsewhere-${counter}`,
    )
    await db.update(sessions).set({ projectId: elsewhere }).where(eq(sessions.lastMessageAt, moved))

    const { body } = await listed("")
    expect(body.learnings).toEqual([
      expect.objectContaining({
        title: "Moved fix",
        problemCount: 2,
        sessionCount: 2,
        firstSeenAt: stayed.toISOString(),
        lastSeenAt: stayed.toISOString(),
        sessionsLast7Days: 0,
      }),
    ])
    expect(await titles(`&from=${daysAgo(5).toISOString()}`)).toEqual([])
  })

  /** A finished run of `project`, started at `startedAt`, written straight to the table. */
  const insertRun = async (
    startedAt: Date,
    fields: { readonly status?: string; readonly error?: string; readonly project?: string } = {},
  ) => {
    const [run] = await db
      .insert(learningRuns)
      .values({
        projectId: fields.project ?? projectId,
        status: fields.status ?? "done",
        error: fields.error ?? null,
        startedAt,
        finishedAt: new Date(startedAt.getTime() + 60_000),
      })
      .returning()
    return run?.id as string
  }

  const insertFix = async (title: string, runId: string, priority = "high") => {
    const [fix] = await db
      .insert(learnings)
      .values({
        projectId,
        updatedByRunId: runId,
        title,
        cause: "c",
        problem: "p",
        priority,
        priorityReason: "r",
        fixType: "skill",
        fix: "f",
      })
      .returning()
    return fix?.id as string
  }

  /** One problem, in a session of its own, that `runId` considered and linked to `fixId`. */
  const linkProblem = async (runId: string, fixId: string) => {
    counter += 1
    const sessionId = `route-run-${counter}`
    await seedSession(db, { sessionId, projectId, userId, problems: [problemFixture("x")] })
    await db
      .update(reviewProblems)
      .set({ learningId: fixId, learningRunId: runId })
      .where(eq(reviewProblems.sessionId, sessionId))
  }

  /**
   * Run A (oldest) creates L1 and L2; run B updates L1 and creates L3; run C failed and linked
   * nothing. Another project has a run of its own.
   */
  const seedRuns = async () => {
    const runA = await insertRun(new Date("2026-11-01T10:00:00Z"))
    const runB = await insertRun(new Date("2026-11-05T10:00:00Z"))
    const runC = await insertRun(new Date("2026-11-09T10:00:00Z"), {
      status: "failed",
      error: "harness timed out",
    })
    const l1 = await insertFix("L1", runB, "high")
    const l2 = await insertFix("L2", runA, "low")
    const l3 = await insertFix("L3", runB, "medium")
    await linkProblem(runA, l1)
    await linkProblem(runA, l2)
    await linkProblem(runB, l1)
    await linkProblem(runB, l3)
    const other = await seedProject(
      db,
      await seedOrg(db, `other-org-${counter}`),
      `other-${counter}`,
    )
    await insertRun(new Date("2026-11-10T10:00:00Z"), { project: other })
    return { runA, runB, runC }
  }

  type ListedRunBody = {
    runs: Array<{ id: string; fixesCreated: number; fixesUpdated: number; error: string | null }>
    canEdit: boolean
  }

  test("SC724: a project's runs list newest first with how many fixes each created and updated", async () => {
    const { runA, runB, runC } = await seedRuns()

    const res = await request(`/api/learnings/runs?project=${projectId}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as ListedRunBody
    expect(body.runs.map((run) => [run.id, run.fixesCreated, run.fixesUpdated, run.error])).toEqual(
      [
        [runC, 0, 0, "harness timed out"],
        [runB, 1, 1, null],
        [runA, 2, 0, null],
      ],
    )
    expect(body.canEdit).toBe(true)
  })

  test("SC725: a stranger cannot list a project's runs, and a viewer reads them with canEdit false", async () => {
    await seedRuns()

    const stranger = await request(`/api/learnings/runs?project=${projectId}`, { as: strangerId })
    expect(stranger.status).toBe(404)
    expect(await stranger.json()).toEqual({ error: "projectNotFound" })

    const viewer = await request(`/api/learnings/runs?project=${projectId}`, {
      as: await newViewer(),
    })
    expect(viewer.status).toBe(200)
    expect(((await viewer.json()) as ListedRunBody).canEdit).toBe(false)
  })

  test("SC726: a run filter lists the fixes that run touched, in list order, each marked new or updated", async () => {
    const { runA, runB } = await seedRuns()
    const marks = async (query: string) => {
      const res = await request(`/api/learnings?project=${projectId}${query}`)
      const body = (await res.json()) as {
        learnings: Array<{ title: string; runMark: string | null }>
      }
      return body.learnings.map((row) => [row.title, row.runMark])
    }

    expect(await marks(`&run=${runB}`)).toEqual([
      ["L1", "updated"],
      ["L3", "new"],
    ])
    expect(await marks(`&run=${runA}`)).toEqual([
      ["L1", "new"],
      ["L2", "new"],
    ])
    expect(await marks("")).toEqual([
      ["L1", null],
      ["L3", null],
      ["L2", null],
    ])
    expect((await request(`/api/learnings?project=${projectId}&run=not-a-uuid`)).status).toBe(400)
  })

  test("SC732: the runs list says how many of the project's reviews are waiting or running", async () => {
    /** A session in `project` whose one review has `status`. */
    const reviewWith = async (status: string, project = projectId) => {
      counter += 1
      const sessionId = `route-pending-${counter}`
      await seedSession(db, { sessionId, projectId: project, userId, problems: [] })
      await db
        .update(sessionReviews)
        .set({ status, outcome: status === "done" ? "shipped" : null })
        .where(eq(sessionReviews.sessionId, sessionId))
    }
    for (const status of ["waiting", "running", "done", "failed"]) await reviewWith(status)
    const other = await seedProject(
      db,
      await seedOrg(db, `pending-org-${counter}`),
      `pending-${counter}`,
    )
    await reviewWith("waiting", other)

    const res = await request(`/api/learnings/runs?project=${projectId}`)
    expect(((await res.json()) as { reviewsWaiting: number }).reviewsWaiting).toBe(2)
  })
})
