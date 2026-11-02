import type { HarnessRunner } from "@samskara/core"
import pino from "pino"
import { describe, expect, test } from "vitest"
import type { Db } from "../../db/client.js"
import type { Env } from "../../lib/env.js"
import { type AiReviewJobRegistry, createAiReviewJobRegistry } from "../ai-review/jobs.js"
import type { AiReviewDeps, AiReviewErrorCode, AiReviewResult } from "../ai-review/pipeline.js"
import type { StartedLearningRun } from "../learnings/run.js"
import {
  type BatchProject,
  type BatchSession,
  createReviewBatchRegistry,
  type ReviewBatchDeps,
  type ReviewBatchInput,
} from "./batch.js"

const silentLog = pino({ level: "silent" })

/** The registry's run is replaced, so these are never read; they only satisfy the type. */
const aiReview: AiReviewDeps = {
  db: {} as Db,
  runner: {} as HarnessRunner,
  env: {} as Env,
  log: silentLog,
}

/** Yields to the event loop, so poll loops never starve the test. */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

const waitUntil = async (check: () => boolean, label: string): Promise<void> => {
  for (let i = 0; i < 2_000; i += 1) {
    if (check()) return
    await tick()
  }
  throw new Error(`never happened: ${label}`)
}

/** Lets a few turns of the event loop pass, to show something did NOT happen. */
const settleLoop = async (): Promise<void> => {
  for (let i = 0; i < 50; i += 1) await tick()
}

type Pending = {
  readonly userId: string
  readonly sessionId: string
  readonly resolve: (result: AiReviewResult) => void
}

/** A job `run` the test settles by hand, one call at a time. */
const controlledRun = () => {
  const pending: Pending[] = []
  const calls: string[] = []
  const run = (_deps: AiReviewDeps, userId: string, sessionId: string) =>
    new Promise<AiReviewResult>((resolve) => {
      calls.push(sessionId)
      pending.push({ userId, sessionId, resolve })
    })
  const settle = (sessionId: string, result: AiReviewResult): void => {
    const index = pending.findIndex((entry) => entry.sessionId === sessionId)
    const [entry] = pending.splice(index, 1)
    if (entry === undefined) throw new Error(`no pending review for ${sessionId}`)
    entry.resolve(result)
  }
  return { run, calls, pending, settle }
}

const ok = (sessionId: string): AiReviewResult =>
  ({ kind: "ok", reviewId: `review-${sessionId}`, review: {} }) as unknown as AiReviewResult
const failed = (code: AiReviewErrorCode): AiReviewResult => ({ kind: "error", code })

const started = (finished: Promise<"done" | "failed">): StartedLearningRun => ({
  status: "started",
  runId: crypto.randomUUID(),
  finished,
})

const build = (
  jobs: AiReviewJobRegistry,
  overrides: Partial<ReviewBatchDeps> = {},
): ReturnType<typeof createReviewBatchRegistry> =>
  createReviewBatchRegistry({
    jobs,
    aiReview,
    hasReview: async () => false,
    canWrite: async () => true,
    startLearningRun: async () => started(Promise.resolve("done")),
    log: silentLog,
    sleep: tick,
    pollMs: 1,
    learningRetryMs: 1,
    ...overrides,
  })

const input = (
  sessions: ReadonlyArray<readonly [string, string]>,
  extra: Partial<ReviewBatchInput> = {},
): ReviewBatchInput => ({
  userId: "user-1",
  sessions: sessions.map(([sessionId, projectId]) => ({ sessionId, projectId })),
  notAllowed: [],
  projectNames: new Map([
    ["project-a", "Project A"],
    ["project-b", "Project B"],
  ]),
  ...extra,
})

const sessionOf = (
  registry: ReturnType<typeof createReviewBatchRegistry>,
  sessionId: string,
  userId = "user-1",
): BatchSession | undefined =>
  registry.current(userId)?.sessions.find((session) => session.sessionId === sessionId)

const projectOf = (
  registry: ReturnType<typeof createReviewBatchRegistry>,
  projectId: string,
): BatchProject | undefined =>
  registry.current("user-1")?.projects.find((project) => project.projectId === projectId)

const runningCount = (jobs: AiReviewJobRegistry, ids: ReadonlyArray<string>): number =>
  ids.filter((id) => jobs.activeJobForSession(id) !== undefined).length

describe("review batch registry", () => {
  test("SC1: a session that already has a review is skipped, not reviewed again", async () => {
    const control = controlledRun()
    const jobs = createAiReviewJobRegistry({ run: control.run })
    const registry = build(jobs, { hasReview: async (_user, sessionId) => sessionId === "s1" })

    const result = registry.start(
      input([
        ["s1", "project-a"],
        ["s2", "project-a"],
      ]),
    )
    if ("error" in result) throw new Error("refused")
    await waitUntil(() => control.pending.length === 1, "s2 review started")
    control.settle("s2", ok("s2"))
    await result.finished

    expect(sessionOf(registry, "s1")?.state).toBe("skipped")
    expect(control.calls).toEqual(["s2"])
    expect(sessionOf(registry, "s2")?.state).toBe("reviewed")
  })

  test("SC2: the batch never runs more than 3 reviews at once", async () => {
    const control = controlledRun()
    const jobs = createAiReviewJobRegistry({ run: control.run })
    const registry = build(jobs)
    const ids = ["s1", "s2", "s3", "s4", "s5", "s6", "s7"]

    const result = registry.start(input(ids.map((id) => [id, "project-a"] as const)))
    if ("error" in result) throw new Error("refused")
    await waitUntil(() => control.pending.length === 3, "3 reviews running")
    await settleLoop()
    expect(runningCount(jobs, ids)).toBe(3)

    let peak = 0
    while (control.pending.length > 0) {
      const next = control.pending[0]
      if (next === undefined) break
      control.settle(next.sessionId, ok(next.sessionId))
      await settleLoop()
      peak = Math.max(peak, runningCount(jobs, ids))
    }
    await result.finished

    expect(peak).toBeLessThanOrEqual(3)
    expect(control.calls).toHaveLength(7)
    expect(registry.current("user-1")?.sessions.map((session) => session.state)).toEqual(
      Array.from({ length: 7 }, () => "reviewed"),
    )
  })

  test("two users' batches together run at most 3 reviews, so a manual Analyze still finds the 4th slot", async () => {
    const control = controlledRun()
    const jobs = createAiReviewJobRegistry({ run: control.run })
    const registry = build(jobs)
    const first = ["a1", "a2", "a3"]
    const second = ["b1", "b2", "b3"]

    const one = registry.start(input(first.map((id) => [id, "project-a"] as const)))
    const two = registry.start(
      input(
        second.map((id) => [id, "project-b"] as const),
        { userId: "user-2" },
      ),
    )
    if ("error" in one || "error" in two) throw new Error("refused")
    await waitUntil(() => control.pending.length === 3, "3 reviews running")
    await settleLoop()

    expect(runningCount(jobs, [...first, ...second])).toBe(3)
    expect("jobId" in jobs.startAiReviewJob(aiReview, "someone-else", "manual", {})).toBe(true)

    control.settle("manual", ok("manual"))
    while (control.pending.length > 0) {
      const next = control.pending[0]
      if (next === undefined) break
      control.settle(next.sessionId, ok(next.sessionId))
      await settleLoop()
      expect(runningCount(jobs, [...first, ...second])).toBeLessThanOrEqual(3)
    }
    await Promise.all([one.finished, two.finished])
    expect(sessionOf(registry, "b3", "user-2")?.state).toBe("reviewed")
  })

  test("SC3: a busy job registry makes a lane wait, not fail", async () => {
    const control = controlledRun()
    const jobs = createAiReviewJobRegistry({ run: control.run, maxConcurrent: 1 })
    jobs.startAiReviewJob(aiReview, "someone-else", "other-session", {})
    const registry = build(jobs)

    const result = registry.start(input([["s1", "project-a"]]))
    if ("error" in result) throw new Error("refused")
    await settleLoop()
    expect(sessionOf(registry, "s1")?.state).toBe("waiting")

    control.settle("other-session", ok("other-session"))
    await waitUntil(() => control.calls.includes("s1"), "s1 started after the slot freed")
    control.settle("s1", ok("s1"))
    await result.finished

    expect(sessionOf(registry, "s1")?.state).toBe("reviewed")
  })

  test("SC4: a failed review is recorded and the batch goes on", async () => {
    const control = controlledRun()
    const jobs = createAiReviewJobRegistry({ run: control.run })
    const registry = build(jobs)

    const result = registry.start(
      input([
        ["s1", "project-a"],
        ["s2", "project-a"],
        ["s3", "project-a"],
      ]),
    )
    if ("error" in result) throw new Error("refused")
    await waitUntil(() => control.pending.length === 3, "3 reviews running")
    control.settle("s1", ok("s1"))
    control.settle("s2", failed("harnessFailed"))
    control.settle("s3", ok("s3"))
    await result.finished

    expect(sessionOf(registry, "s2")).toMatchObject({
      state: "failed",
      reason: "The reviewer stopped with an error.",
    })
    expect(sessionOf(registry, "s1")?.state).toBe("reviewed")
    expect(sessionOf(registry, "s3")?.state).toBe("reviewed")
    expect(registry.current("user-1")?.status).toBe("done")
  })

  test("SC5: step 2 runs once per project, only for projects with a review", async () => {
    const control = controlledRun()
    const jobs = createAiReviewJobRegistry({ run: control.run })
    const learningCalls: string[] = []
    const registry = build(jobs, {
      hasReview: async (_user, sessionId) => sessionId === "a2",
      startLearningRun: async (projectId) => {
        learningCalls.push(projectId)
        return started(Promise.resolve("done"))
      },
    })

    const result = registry.start(
      input([
        ["a1", "project-a"],
        ["a2", "project-a"],
        ["b1", "project-b"],
      ]),
    )
    if ("error" in result) throw new Error("refused")
    await waitUntil(() => control.pending.length === 2, "a1 and b1 started")
    control.settle("a1", ok("a1"))
    control.settle("b1", failed("harnessFailed"))
    await result.finished

    expect(learningCalls).toEqual(["project-a"])
    expect(projectOf(registry, "project-a")?.state).toBe("done")
    expect(projectOf(registry, "project-b")).toMatchObject({
      state: "failed",
      reason: "No session of this project got a review.",
    })
  })

  test("SC6: step 2 runs projects one after another", async () => {
    const jobs = createAiReviewJobRegistry({ run: async (_d, _u, id) => ok(id) })
    const learningCalls: string[] = []
    let finishA: (result: "done" | "failed") => void = () => {}
    const registry = build(jobs, {
      startLearningRun: async (projectId) => {
        learningCalls.push(projectId)
        if (projectId === "project-a")
          return started(
            new Promise((resolve) => {
              finishA = resolve
            }),
          )
        return started(Promise.resolve("done"))
      },
    })

    const result = registry.start(
      input([
        ["a1", "project-a"],
        ["b1", "project-b"],
      ]),
    )
    if ("error" in result) throw new Error("refused")
    await waitUntil(() => learningCalls.length === 1, "project A run started")
    await settleLoop()
    expect(learningCalls).toEqual(["project-a"])
    expect(projectOf(registry, "project-a")?.state).toBe("running")

    finishA("done")
    await result.finished
    expect(learningCalls).toEqual(["project-a", "project-b"])
    expect(projectOf(registry, "project-b")?.state).toBe("done")
  })

  test("SC7: a project whose learning run is already going is waited for, then run", async () => {
    const jobs = createAiReviewJobRegistry({ run: async (_d, _u, id) => ok(id) })
    let calls = 0
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const registry = build(jobs, {
      startLearningRun: async () => {
        calls += 1
        if (calls === 1) return { status: "busy" }
        if (calls === 2) {
          await gate
          return { status: "busy" }
        }
        return started(Promise.resolve("done"))
      },
    })

    const result = registry.start(input([["a1", "project-a"]]))
    if ("error" in result) throw new Error("refused")
    await waitUntil(() => calls === 2, "asked twice")
    expect(projectOf(registry, "project-a")?.state).toBe("waiting")
    release()
    await result.finished

    expect(projectOf(registry, "project-a")?.state).toBe("done")
    expect(calls).toBe(3)
  })

  test("SC8: a project still busy after the wait limit fails with a plain reason", async () => {
    const jobs = createAiReviewJobRegistry({ run: async (_d, _u, id) => ok(id) })
    let clock = 0
    const registry = build(jobs, {
      now: () => new Date(clock),
      sleep: async (ms) => {
        clock += ms
        await tick()
      },
      learningRetryMs: 60,
      learningWaitLimitMs: 300,
      startLearningRun: async () => ({ status: "busy" }),
    })

    const result = registry.start(input([["a1", "project-a"]]))
    if ("error" in result) throw new Error("refused")
    await result.finished

    expect(projectOf(registry, "project-a")).toMatchObject({
      state: "failed",
      reason: "Another fix run for this project did not end within 2 hours.",
    })
    expect(registry.current("user-1")?.status).toBe("done")
  })

  test("SC9: with no learnings harness, every project's step 2 fails with a plain reason", async () => {
    const jobs = createAiReviewJobRegistry({ run: async (_d, _u, id) => ok(id) })
    const registry = build(jobs, { startLearningRun: undefined })

    const result = registry.start(
      input([
        ["a1", "project-a"],
        ["b1", "project-b"],
      ]),
    )
    if ("error" in result) throw new Error("refused")
    await result.finished

    expect(sessionOf(registry, "a1")?.state).toBe("reviewed")
    expect(sessionOf(registry, "b1")?.state).toBe("reviewed")
    for (const projectId of ["project-a", "project-b"]) {
      const project = projectOf(registry, projectId)
      expect(project?.state).toBe("failed")
      expect(project?.reason).toContain("Finding fixes is not set up on this server")
    }
  })

  test("a user who lost edit rights during step 1 gets no fix run for that project", async () => {
    const jobs = createAiReviewJobRegistry({ run: async (_d, _u, id) => ok(id) })
    const learningCalls: string[] = []
    const registry = build(jobs, {
      canWrite: async (_user, projectId) => projectId !== "project-a",
      startLearningRun: async (projectId) => {
        learningCalls.push(projectId)
        return started(Promise.resolve("done"))
      },
    })

    const result = registry.start(
      input([
        ["a1", "project-a"],
        ["b1", "project-b"],
      ]),
    )
    if ("error" in result) throw new Error("refused")
    await result.finished

    expect(learningCalls).toEqual(["project-b"])
    expect(projectOf(registry, "project-a")?.state).toBe("failed")
    expect(projectOf(registry, "project-a")?.reason).toBeTruthy()
    expect(projectOf(registry, "project-b")?.state).toBe("done")
  })

  test("SC10: a review job the registry already dropped is judged by its saved row", async () => {
    const saved = new Set<string>()
    const jobs = createAiReviewJobRegistry({
      maxSettled: 0,
      run: async (_d, _u, sessionId) => {
        if (sessionId === "s1") {
          saved.add("s1")
          return ok("s1")
        }
        return failed("harnessFailed")
      },
    })
    const registry = build(jobs, { hasReview: async (_user, sessionId) => saved.has(sessionId) })

    const result = registry.start(
      input([
        ["s1", "project-a"],
        ["s2", "project-a"],
      ]),
    )
    if ("error" in result) throw new Error("refused")
    await result.finished

    expect(sessionOf(registry, "s1")?.state).toBe("reviewed")
    expect(sessionOf(registry, "s2")).toMatchObject({
      state: "failed",
      reason: "The review ended, but its result was lost before the batch read it.",
    })
  })

  test("SC11: a start is refused while the user's batch runs, and allowed once it is done", async () => {
    const control = controlledRun()
    const jobs = createAiReviewJobRegistry({ run: control.run })
    const registry = build(jobs)

    const first = registry.start(input([["s1", "project-a"]]))
    if ("error" in first) throw new Error("refused")
    expect(registry.start(input([["s2", "project-a"]]))).toEqual({ error: "alreadyRunning" })
    const other = registry.start(input([["s3", "project-a"]], { userId: "user-2" }))
    expect("batchId" in other).toBe(true)

    await waitUntil(() => control.pending.length === 2, "both reviews started")
    control.settle("s1", ok("s1"))
    control.settle("s3", ok("s3"))
    await first.finished

    const again = registry.start(input([["s4", "project-a"]]))
    if ("error" in again) throw new Error("refused after the first batch ended")
    expect(registry.current("user-1")?.batchId).toBe(again.batchId)
  })

  test("not-allowed sessions are recorded without a project and never reviewed", async () => {
    const control = controlledRun()
    const jobs = createAiReviewJobRegistry({ run: control.run })
    const registry = build(jobs)

    const result = registry.start(input([], { notAllowed: ["hidden"] }))
    if ("error" in result) throw new Error("refused")
    await result.finished

    expect(sessionOf(registry, "hidden")).toEqual({
      sessionId: "hidden",
      projectId: null,
      state: "notAllowed",
      reason: null,
    })
    expect(control.calls).toEqual([])
    expect(registry.current("user-1")?.status).toBe("done")
  })
})
