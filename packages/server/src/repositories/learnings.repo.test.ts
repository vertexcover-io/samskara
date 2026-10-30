import type { Problem } from "@samskara/core"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest"
import type { Db } from "../db/client.js"
import { learningRuns, learnings, reviewProblems, users } from "../db/schema.js"
import { dockerAvailable, startTestDb } from "../db/testDb.js"
import {
  problemFixture,
  seedOrg,
  seedProject,
  seedSession as seedSessionFixture,
} from "../services/learnings/testFixtures.js"
import * as learningsRepo from "./learnings.repo.js"

const problem = problemFixture

const written = {
  verdict: "learning",
  title: "Helpers report while their run is still going",
  problem: "The orchestrator has to chase them.",
  priority: "high",
  priorityReason: "3 sessions",
  fixType: "skill",
  fix: "In skills/implement/SKILL.md, add a wait rule.",
  impact: "time_only",
  impactReason: "lost a few minutes",
  howItHelps: "Saves a few minutes a run.",
} as const

describe.skipIf(!dockerAvailable())("learnings repository", () => {
  let teardown: () => Promise<void>
  let db: Db
  let counter = 0
  let orgId: string
  let projectId: string
  let userId: string

  /** A session in `project`, with one review holding `problems`. */
  const seedSession = async (problems: ReadonlyArray<Problem>, project = projectId) => {
    counter += 1
    const sessionId = `learn-session-${counter}`
    await seedSessionFixture(db, { sessionId, projectId: project, userId, problems })
    return sessionId
  }

  const newProject = (slug: string): Promise<string> => seedProject(db, orgId, slug)

  beforeAll(async () => {
    const started = await startTestDb()
    db = started.db
    teardown = started.teardown
    const [user] = await db
      .insert(users)
      .values({ githubId: 7001, githubLogin: "learner" })
      .returning()
    if (!user) throw new Error("seed user failed")
    userId = user.id
  }, 120_000)

  beforeEach(async () => {
    await db.delete(reviewProblems)
    await db.delete(learnings)
    await db.delete(learningRuns)
    counter += 1
    orgId = await seedOrg(db, `org-${counter}`)
    projectId = await newProject(`project-${counter}`)
  })

  afterAll(async () => {
    await teardown?.()
  })

  test("LDB1: only one run per project can be running; a second start gets null", async () => {
    const other = await learningsRepo.startRun(db, await newProject(`side-${counter}`))
    expect(other?.status).toBe("running")
    const first = await learningsRepo.startRun(db, projectId)
    expect(first?.status).toBe("running")
    expect(await learningsRepo.startRun(db, projectId)).toBeNull()
    await learningsRepo.finishRun(db, first?.id as string, { status: "done" })
    expect(await learningsRepo.startRun(db, projectId)).not.toBeNull()
  })

  test("LDB2: unmarked problems are this project's problems no run has considered, oldest first", async () => {
    await seedSession([problem("First"), problem("Second")])
    // Another project, even in the same org, has its own learnings.
    await seedSession([problem("Elsewhere")], await newProject(`other-${counter}`))
    const picked = await learningsRepo.unmarkedProblems(db, projectId, 10)
    expect(picked.map((row) => row.title)).toEqual(["First", "Second"])
    expect(picked[0]).toMatchObject({ class: "slow", severity: "medium", fixType: "skill" })
    expect(await learningsRepo.unmarkedProblems(db, projectId, 1)).toHaveLength(1)
  })

  test("LDB3: saving a batch creates learnings, links their problems, and marks every problem", async () => {
    await seedSession([problem("A"), problem("B"), problem("C")])
    const run = await learningsRepo.startRun(db, projectId)
    const [a, b, c] = await learningsRepo.unmarkedProblems(db, projectId, 10)
    await learningsRepo.saveBatch(db, {
      runId: run?.id as string,
      projectId,
      groups: [
        {
          cause: "No wait rule.",
          learningId: null,
          problemIds: [a?.id as string, b?.id as string],
          answer: written,
        },
        {
          cause: "Mocks allowed.",
          learningId: null,
          problemIds: [c?.id as string],
          answer: { verdict: "drop", reason: "one session, a one-off" },
        },
      ],
    })
    expect(await learningsRepo.unmarkedProblems(db, projectId, 10)).toEqual([])
    const saved = await db.select().from(learnings)
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({
      cause: "No wait rule.",
      priority: "high",
      updatedByRunId: run?.id,
    })
    const linked = await db
      .select()
      .from(reviewProblems)
      .where(eq(reviewProblems.learningId, saved[0]?.id as string))
    expect(linked.map((row) => row.title).sort()).toEqual(["A", "B"])
    const dropped = await db.select().from(reviewProblems).where(eq(reviewProblems.title, "C"))
    expect(dropped[0]).toMatchObject({ learningRunId: run?.id, learningId: null })
  })

  test("LDB4: a later run updates the learning it joins and links its problems too", async () => {
    await seedSession([problem("A")])
    const first = await learningsRepo.startRun(db, projectId)
    const [a] = await learningsRepo.unmarkedProblems(db, projectId, 10)
    await learningsRepo.saveBatch(db, {
      runId: first?.id as string,
      projectId,
      groups: [
        {
          cause: "No wait rule.",
          learningId: null,
          problemIds: [a?.id as string],
          answer: { ...written, priority: "low" },
        },
      ],
    })
    await learningsRepo.finishRun(db, first?.id as string, { status: "done" })
    const [existing] = await learningsRepo.learningsForGrouping(db, projectId)

    await seedSession([problem("B")])
    const second = await learningsRepo.startRun(db, projectId)
    const [b] = await learningsRepo.unmarkedProblems(db, projectId, 10)
    await learningsRepo.saveBatch(db, {
      runId: second?.id as string,
      projectId,
      groups: [
        {
          cause: "No wait rule.",
          learningId: existing?.id as string,
          problemIds: [b?.id as string],
          answer: written,
        },
      ],
    })
    const rows = await db.select().from(learnings)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ priority: "high", updatedByRunId: second?.id })
    const full = await learningsRepo.learningsWithProblems(db, [existing?.id as string])
    expect(full[0]?.problems.map((row) => row.title).sort()).toEqual(["A", "B"])
  })

  test("LDB5: the list shows each learning with its problem and session counts, high priority first", async () => {
    await seedSession([problem("A"), problem("B")])
    await seedSession([problem("C")])
    const run = await learningsRepo.startRun(db, projectId)
    const [a, b, c] = await learningsRepo.unmarkedProblems(db, projectId, 10)
    await learningsRepo.saveBatch(db, {
      runId: run?.id as string,
      projectId,
      groups: [
        {
          cause: "x",
          learningId: null,
          problemIds: [a?.id as string],
          answer: { ...written, title: "Low one", priority: "low" },
        },
        {
          cause: "y",
          learningId: null,
          problemIds: [b?.id as string, c?.id as string],
          answer: written,
        },
      ],
    })
    const list = await learningsRepo.listLearnings(db, projectId)
    expect(list.map((row) => [row.title, row.problemCount, row.sessionCount])).toEqual([
      ["Helpers report while their run is still going", 2, 2],
      ["Low one", 1, 1],
    ])
  })

  test("SC9: a saved learning keeps its impact and how it helps on create and on update", async () => {
    await seedSession([problem("A")])
    const first = await learningsRepo.startRun(db, projectId)
    const [a] = await learningsRepo.unmarkedProblems(db, projectId, 10)
    await learningsRepo.saveBatch(db, {
      runId: first?.id as string,
      projectId,
      groups: [{ cause: "x", learningId: null, problemIds: [a?.id as string], answer: written }],
    })
    await learningsRepo.finishRun(db, first?.id as string, { status: "done" })
    const [created] = await db.select().from(learnings)
    expect(created).toMatchObject({
      impact: "time_only",
      impactReason: "lost a few minutes",
      howItHelps: "Saves a few minutes a run.",
    })

    await seedSession([problem("B")])
    const second = await learningsRepo.startRun(db, projectId)
    const [b] = await learningsRepo.unmarkedProblems(db, projectId, 10)
    await learningsRepo.saveBatch(db, {
      runId: second?.id as string,
      projectId,
      groups: [
        {
          cause: "x",
          learningId: created?.id as string,
          problemIds: [b?.id as string],
          answer: {
            ...written,
            impact: "wrong_result",
            impactReason: "one run shipped untested code",
            howItHelps: "Stops untested code from shipping.",
          },
        },
      ],
    })
    const [updated] = await db.select().from(learnings)
    expect(updated).toMatchObject({
      impact: "wrong_result",
      impactReason: "one run shipped untested code",
      howItHelps: "Stops untested code from shipping.",
    })
  })

  test("SC10: at the same priority, wrong_result in 1 session lists above time_only in 2, and none comes last", async () => {
    await seedSession([problem("A"), problem("B"), problem("C")])
    await seedSession([problem("D")])
    const run = await learningsRepo.startRun(db, projectId)
    const [a, b, c, d] = await learningsRepo.unmarkedProblems(db, projectId, 10)
    await learningsRepo.saveBatch(db, {
      runId: run?.id as string,
      projectId,
      groups: [
        {
          cause: "x",
          learningId: null,
          problemIds: [a?.id as string, d?.id as string],
          answer: { ...written, title: "Time" },
        },
        {
          cause: "y",
          learningId: null,
          problemIds: [b?.id as string],
          answer: { ...written, title: "None" },
        },
        {
          cause: "z",
          learningId: null,
          problemIds: [c?.id as string],
          answer: { ...written, title: "Wrong", impact: "wrong_result" },
        },
      ],
    })
    await db
      .update(learnings)
      .set({ impact: null, impactReason: null, howItHelps: null })
      .where(eq(learnings.title, "None"))
    const list = await learningsRepo.listLearnings(db, projectId)
    expect(list.map((row) => row.title)).toEqual(["Wrong", "Time", "None"])
  })

  test("SC11: the database refuses an impact outside the list", async () => {
    const run = await learningsRepo.startRun(db, projectId)
    await expect(
      db.insert(learnings).values({
        projectId,
        updatedByRunId: run?.id as string,
        title: "t",
        cause: "c",
        problem: "p",
        priority: "low",
        priorityReason: "r",
        fixType: "skill",
        fix: "f",
        impact: "bad",
      }),
    ).rejects.toThrow(/learnings_impact_check/)
  })

  /** One saved learning from one fresh problem; returns its row. */
  const savedLearning = async () => {
    await seedSession([problem("A")])
    const run = await learningsRepo.startRun(db, projectId)
    const [a] = await learningsRepo.unmarkedProblems(db, projectId, 10)
    await learningsRepo.saveBatch(db, {
      runId: run?.id as string,
      projectId,
      groups: [{ cause: "x", learningId: null, problemIds: [a?.id as string], answer: written }],
    })
    await learningsRepo.finishRun(db, run?.id as string, { status: "done" })
    const [row] = await db.select().from(learnings)
    if (row === undefined) throw new Error("no learning saved")
    return row
  }

  test("SC26: skipping stamps the time and the person, unskipping clears both, and nothing else moves", async () => {
    const before = await savedLearning()
    const skipped = await learningsRepo.setSkipped(db, before.id, userId)
    expect(skipped?.skippedAt).toBeInstanceOf(Date)
    expect(skipped?.skippedBy).toBe(userId)
    expect(skipped).toMatchObject({
      title: before.title,
      fix: before.fix,
      updatedAt: before.updatedAt,
    })
    const unskipped = await learningsRepo.setSkipped(db, before.id, null)
    expect(unskipped).toMatchObject({
      skippedAt: null,
      skippedBy: null,
      updatedAt: before.updatedAt,
    })
  })

  test("a second skip of an already skipped learning keeps who skipped it first, and when", async () => {
    const before = await savedLearning()
    const [other] = await db
      .insert(users)
      .values({ githubId: 7002, githubLogin: "second-skipper" })
      .returning()
    const first = await learningsRepo.setSkipped(db, before.id, userId)
    const second = await learningsRepo.setSkipped(db, before.id, other?.id as string)
    expect(second).toMatchObject({ id: before.id, skippedBy: userId, skippedAt: first?.skippedAt })
  })

  test("SC27: a later run joining a skipped learning rewrites its text but keeps it skipped", async () => {
    const before = await savedLearning()
    const skipped = await learningsRepo.setSkipped(db, before.id, userId)
    await seedSession([problem("B")])
    const run = await learningsRepo.startRun(db, projectId)
    const [b] = await learningsRepo.unmarkedProblems(db, projectId, 10)
    await learningsRepo.saveBatch(db, {
      runId: run?.id as string,
      projectId,
      groups: [
        {
          cause: "x",
          learningId: before.id,
          problemIds: [b?.id as string],
          answer: { ...written, title: "Rewritten by the second run" },
        },
      ],
    })
    const rows = await db.select().from(learnings)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      title: "Rewritten by the second run",
      skippedAt: skipped?.skippedAt,
      skippedBy: userId,
    })
    const [full] = await learningsRepo.learningsWithProblems(db, [before.id])
    expect(full?.problems.map((row) => row.title).sort()).toEqual(["A", "B"])
  })

  test("SC28: the grouper is still shown a skipped learning, so its cause joins it", async () => {
    const before = await savedLearning()
    await learningsRepo.setSkipped(db, before.id, userId)
    expect((await learningsRepo.learningsForGrouping(db, projectId)).map((row) => row.id)).toEqual([
      before.id,
    ])
  })

  test("LDB6: a group whose problems were replaced by a redone review makes no empty learning", async () => {
    await seedSession([problem("A")])
    const run = await learningsRepo.startRun(db, projectId)
    const [a] = await learningsRepo.unmarkedProblems(db, projectId, 10)
    await db.delete(reviewProblems).where(eq(reviewProblems.id, a?.id as string))
    await learningsRepo.saveBatch(db, {
      runId: run?.id as string,
      projectId,
      groups: [{ cause: "x", learningId: null, problemIds: [a?.id as string], answer: written }],
    })
    expect(await db.select().from(learnings)).toEqual([])
  })

  test("LDB7: runs left running by a stopped server are marked failed", async () => {
    const run = await learningsRepo.startRun(db, projectId)
    await learningsRepo.failInterruptedRuns(db)
    const [row] = await db
      .select()
      .from(learningRuns)
      .where(eq(learningRuns.id, run?.id as string))
    expect(row).toMatchObject({ status: "failed", error: "the server stopped during the run" })
  })

  test("LDB8: a project is due when it has unread problems and no run since the cutoff", async () => {
    await seedSession([problem("A")])
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    expect(await learningsRepo.projectsDueForRun(db, weekAgo)).toContain(projectId)
    const run = await learningsRepo.startRun(db, projectId)
    await learningsRepo.finishRun(db, run?.id as string, { status: "failed", error: "x" })
    // A failed run counts: the project waits until the next week.
    expect(await learningsRepo.projectsDueForRun(db, weekAgo)).not.toContain(projectId)
    expect(await learningsRepo.projectsDueForRun(db, new Date(Date.now() + 1000))).toContain(
      projectId,
    )
  })
})
