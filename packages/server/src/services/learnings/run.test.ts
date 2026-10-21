import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gunzipSync } from "node:zlib"
import type { HarnessRunner, Problem } from "@samskara/core"
import { eq, isNull } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest"
import type { Db } from "../../db/client.js"
import { learningRuns, learnings, reviewProblems, users } from "../../db/schema.js"
import { dockerAvailable, startTestDb } from "../../db/testDb.js"
import type { Env } from "../../lib/env.js"
import { captureLogger } from "../../lib/test-logger.js"
import * as learningsRepo from "../../repositories/learnings.repo.js"
import { runLearnings } from "./run.js"
import {
  fakeAgents,
  harnessRepoFixture,
  problemFixture,
  seedOrg,
  seedProject,
  seedSession as seedSessionFixture,
} from "./testFixtures.js"

const env = { aiReviewHarness: "claude", aiReviewModel: "sonnet" } as Env

const runIdOf = (result: Awaited<ReturnType<typeof runLearnings>>): string => {
  if (result.status === "busy") throw new Error("the run was refused as busy")
  return result.runId
}

describe.skipIf(!dockerAvailable())("runLearnings", () => {
  let teardown: () => Promise<void>
  let db: Db
  let userId: string
  let projectId: string
  let harnessPath: string
  let logDir: string
  let counter = 0

  /**
   * A session with one problem per title, each with `fields`; `texts` become its messages (see
   * the fixture). A single medium session is a one-off code drops, so tests that need agent 2
   * use two sessions or a high-severity problem.
   */
  const seedSession = async (
    titles: ReadonlyArray<string>,
    options: { texts?: ReadonlyArray<string>; fields?: Partial<Problem> } = {},
  ) => {
    counter += 1
    await seedSessionFixture(db, {
      sessionId: `run-learn-${counter}`,
      projectId,
      userId,
      problems: titles.map((title) => problemFixture(title, options.fields)),
      ...(options.texts === undefined ? {} : { texts: options.texts }),
    })
  }
  const high = { fields: { severity: "high" } } as const

  const run = (
    runner: HarnessRunner,
    batchSize?: number,
    priorityLimits?: { high: number; medium: number },
  ) =>
    runLearnings({ db, runner, env, log: captureLogger().log, logDir }, projectId, {
      harnessPath,
      ...(batchSize === undefined ? {} : { batchSize }),
      ...(priorityLimits === undefined ? {} : { priorityLimits }),
    })

  /** The run's log, ungzipped and parsed line by line. */
  const readLog = (runId: string): Array<Record<string, unknown>> =>
    gunzipSync(readFileSync(join(logDir, `${runId}.jsonl.gz`)))
      .toString("utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)

  beforeAll(async () => {
    const started = await startTestDb()
    db = started.db
    teardown = started.teardown
    const [user] = await db
      .insert(users)
      .values({ githubId: 7101, githubLogin: "runner" })
      .returning()
    userId = user?.id as string
    harnessPath = harnessRepoFixture()
    logDir = mkdtempSync(join(tmpdir(), "learning-runs-"))
  }, 120_000)

  beforeEach(async () => {
    await db.delete(reviewProblems)
    await db.delete(learnings)
    await db.delete(learningRuns)
    counter += 1
    projectId = await seedProject(db, await seedOrg(db, `run-org-${counter}`), `run-${counter}`)
  })

  afterAll(async () => {
    rmSync(harnessPath, { recursive: true, force: true })
    rmSync(logDir, { recursive: true, force: true })
    await teardown?.()
  })

  test("LS1: a first run turns the new problems into a learning and marks them all", async () => {
    await seedSession(["A", "B"])
    await seedSession(["C"])
    const { runner } = fakeAgents()
    const result = await run(runner)
    expect(result.status).toBe("done")
    const [saved] = await db
      .select()
      .from(learningRuns)
      .where(eq(learningRuns.id, runIdOf(result)))
    expect(saved).toMatchObject({ status: "done", error: null })
    expect(saved?.harnessRef).toMatch(/^harness-repo-\w+@[0-9a-f]{12}$/)
    const list = await learningsRepo.listLearnings(db, projectId)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      cause: "No wait rule.",
      priority: "high",
      problemCount: 3,
      sessionCount: 2,
    })
    expect(
      await db.select().from(reviewProblems).where(isNull(reviewProblems.learningRunId)),
    ).toEqual([])
  })

  test("LS2: the run's log is gzipped JSONL, one line per step, with the decisions as fields", async () => {
    await seedSession(["A"])
    await seedSession(["B"])
    const result = await run(fakeAgents().runner)
    const lines = readLog(runIdOf(result))
    expect(lines.map((line) => line.step)).toEqual([
      "run.start",
      "harness.snapshot",
      "batch.start",
      "agent1.ids",
      "agent1.answer",
      "batch.one_offs",
      "agent2.answer",
      "batch.saved",
      "run.end",
    ])
    expect(lines.every((line) => line.runId === runIdOf(result))).toBe(true)
    expect(lines.find((line) => line.step === "agent1.ids")).toMatchObject({
      batch: 1,
      problems: [
        { id: "P1", title: "A" },
        { id: "P2", title: "B" },
      ],
    })
    expect(lines.find((line) => line.step === "batch.saved")).toMatchObject({
      groups: [{ group: 1, writerGroup: "G1", action: "created", priority: "high" }],
      priorityUsedThisBatch: { high: 1, medium: 0 },
    })
    expect(lines.at(-1)).toMatchObject({ step: "run.end", status: "done" })
    // Agent 2's input, with its excerpts, can be rebuilt from the database, so it is left out.
    expect(JSON.stringify(lines)).not.toContain("Evidence, with the session around it")
    expect(existsSync(join(logDir, `${runIdOf(result)}.jsonl`))).toBe(false)
  })

  test("LS3: agent 2 sees each new problem's evidence with the session around it; agent 1 does not", async () => {
    const texts = Array.from({ length: 10 }, (_, index) => `message number ${index}`)
    // The problem's evidence cites msg-1 ("waiting on jest" in the fixture), so put it there.
    texts[1] = "I am waiting on jest before I report"
    await seedSession(["A"], { texts, ...high })
    const { runner, seen } = fakeAgents()
    await run(runner)
    expect(seen.writerMd[0]).toContain("Evidence, with the session around it:")
    expect(seen.writerMd[0]).toContain('msg-1 — "waiting on jest" — returned early')
    expect(seen.writerMd[0]).toContain("I am waiting on jest before I report")
    expect(seen.writerMd[0]).toContain("message number 4")
    expect(seen.writerMd[0]).not.toContain("message number 5")
  })

  test("LS4: a group agent 2 drops makes no learning; its problems are marked and the reason logged", async () => {
    await seedSession(["A"], high)
    const result = await run(fakeAgents({ verdict: "drop" }).runner)
    expect(result.status).toBe("done")
    expect(await db.select().from(learnings)).toEqual([])
    const rows = await db.select().from(reviewProblems)
    expect(rows[0]).toMatchObject({ learningRunId: runIdOf(result), learningId: null })
    expect(readLog(runIdOf(result)).find((line) => line.step === "batch.saved")).toMatchObject({
      groups: [{ action: "dropped", reason: "One session, medium and slow, a one-off typo." }],
    })
  })

  test("LS5: the high limit is for the whole run: each batch is told what is left", async () => {
    await seedSession(["A", "B", "C"], high)
    const { runner, seen } = fakeAgents({ oneGroupEach: true })
    await run(runner, 1, { high: 2, medium: 8 })
    expect(seen.writerMd.map((md) => /at most (\d+) new high/.exec(md)?.[1])).toEqual([
      "2",
      "1",
      "0",
    ])
    const list = await learningsRepo.listLearnings(db, projectId)
    expect(list.filter((learning) => learning.priority === "high")).toHaveLength(2)
  })

  test("LS6: a later run joins the learning, and agent 2 sees its old problems with the new", async () => {
    await seedSession(["A"], high)
    await run(fakeAgents().runner)
    await seedSession(["B"], high)
    const { runner, seen } = fakeAgents()
    await run(runner)
    expect(seen.knownLearningsMd[0]).toMatch(/## K1: Helpers report early/)
    expect(seen.writerMd[0]).toContain("update this one")
    expect(seen.writerMd[0]).toContain("2 problems in 2 sessions")
    const list = await learningsRepo.listLearnings(db, projectId)
    expect(list).toHaveLength(1)
    expect(list[0]?.problemCount).toBe(2)
  })

  test("LS7: groups that fail the check fail the run, and no problem is marked", async () => {
    await seedSession(["A", "B"])
    const result = await run(fakeAgents({ badGroups: true }).runner)
    expect(result.status).toBe("failed")
    const [saved] = await db
      .select()
      .from(learningRuns)
      .where(eq(learningRuns.id, runIdOf(result)))
    expect(saved?.error).toMatch(/Not in any group: P1/)
    expect(
      await db.select().from(reviewProblems).where(isNull(reviewProblems.learningRunId)),
    ).toHaveLength(2)
  })

  test("LS8: a long backlog goes in batches, and each batch sees the learnings before it", async () => {
    await seedSession(["A", "B", "C"], high)
    const { runner, seen } = fakeAgents()
    const result = await run(runner, 2)
    expect(result.status).toBe("done")
    expect(seen.knownLearningsMd).toHaveLength(2)
    expect(seen.knownLearningsMd[0]).toContain("None yet")
    expect(seen.knownLearningsMd[1]).toMatch(/## K1:/)
    expect(
      await db.select().from(reviewProblems).where(isNull(reviewProblems.learningRunId)),
    ).toEqual([])
  })

  test("LS9: with nothing new, the run finishes without starting an agent", async () => {
    let calls = 0
    const result = await run({
      run: async () => {
        calls += 1
        return { stdout: "", firstByteMs: 1 }
      },
    })
    expect(result.status).toBe("done")
    expect(calls).toBe(0)
  })

  test("LS10: a second run while one is going is refused", async () => {
    await learningsRepo.startRun(db, projectId)
    const result = await run(fakeAgents().runner)
    expect(result.status).toBe("busy")
  })

  test("LS11: a one-off — one session, nothing high, under 3 times — is dropped by code; agent 2 never sees it", async () => {
    await seedSession(["A", "B"])
    const { runner, seen } = fakeAgents()
    const result = await run(runner)
    expect(result.status).toBe("done")
    expect(seen.writerMd).toEqual([])
    expect(await db.select().from(learnings)).toEqual([])
    const rows = await db.select().from(reviewProblems)
    expect(rows.every((row) => row.learningRunId === runIdOf(result))).toBe(true)
    expect(readLog(runIdOf(result)).find((line) => line.step === "batch.saved")).toMatchObject({
      groups: [
        {
          writerGroup: null,
          action: "dropped",
          reason: "One session, no high-severity problem, and it happened 2 times.",
        },
      ],
    })
  })

  test("LS12: a mistake made 3 times in one session is not a one-off: agent 2 decides it", async () => {
    const three = [1, 2, 3].map((n) => ({
      from: `msg-${n}`,
      to: `msg-${n}`,
      quote: "waiting on jest",
      why: "returned early again",
    }))
    await seedSession(["A"], { fields: { evidence: three } })
    const { runner, seen } = fakeAgents()
    await run(runner)
    expect(seen.writerMd).toHaveLength(1)
    expect(seen.writerMd[0]).toContain("1 problems in 1 sessions, happened 3 times")
    expect(await learningsRepo.listLearnings(db, projectId)).toHaveLength(1)
  })
})
