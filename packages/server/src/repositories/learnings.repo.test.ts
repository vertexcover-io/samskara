import type { LearningStory, Problem } from "@samskara/core"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest"
import type { Db } from "../db/client.js"
import { learningRuns, learnings, reviewProblems, sessions, users } from "../db/schema.js"
import { dockerAvailable, startTestDb } from "../db/testDb.js"
import {
  problemFixture,
  seedOrg,
  seedProject,
  seedSession as seedSessionFixture,
} from "../services/learnings/testFixtures.js"
import * as learningsRepo from "./learnings.repo.js"
import { queueDueFixRuns } from "./workQueue.repo.js"

const problem = problemFixture

const story: LearningStory = {
  steps: [
    { text: "The helper started the tests.", quote: "waiting on jest" },
    { text: "It reported before they finished.", quote: "waiting on jest" },
    { text: "The main agent took that as done.", quote: "waiting on jest" },
  ],
  whyProblem: "Nobody saw the tests pass.",
  shouldHave: "It should have waited for the tests.",
}

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
  fixSummary: "Make the agent wait before it reports.",
  story,
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

  test("SC824: below its return point a skipped fix is rewritten by a run but stays skipped", async () => {
    const before = await savedLearning()
    const skipped = await learningsRepo.setDecision(db, before.id, { decision: "skipped" }, userId)
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
      decision: "skipped",
      decidedAt: skipped?.decidedAt,
      decidedBy: userId,
    })
    const [full] = await learningsRepo.learningsWithProblems(db, [before.id])
    expect(full?.problems.map((row) => row.title).sort()).toEqual(["A", "B"])
  })

  /** A fix run that links one problem from each of `sessions` new sessions to `fixId`. */
  const joinRun = async (
    fixId: string,
    sessionCount: number,
    answer: typeof written | Record<string, unknown> = written,
  ) => {
    for (let index = 0; index < sessionCount; index += 1)
      await seedSession([problem(`Joined ${counter}-${index}`)])
    const run = await learningsRepo.startRun(db, projectId)
    const picked = await learningsRepo.unmarkedProblems(db, projectId, 100)
    await learningsRepo.saveBatch(db, {
      runId: run?.id as string,
      projectId,
      groups: [
        {
          cause: "x",
          learningId: fixId,
          problemIds: picked.map((row) => row.id),
          answer: answer as typeof written,
        },
      ],
    })
    await learningsRepo.finishRun(db, run?.id as string, { status: "done" })
    const [row] = await db.select().from(learnings).where(eq(learnings.id, fixId))
    if (row === undefined) throw new Error("the fix is gone")
    return row
  }

  test("SC821: a run reopens a fix skipped once when it reaches 10 more sessions, and not at 9", async () => {
    const before = await savedLearning()
    const skipped = await learningsRepo.setDecision(db, before.id, { decision: "skipped" }, userId)
    expect(skipped).toMatchObject({ sessionsAtSkip: 1, skipCount: 1 })

    const afterNine = await joinRun(before.id, 9)
    expect(afterNine).toMatchObject({ decision: "skipped", decidedBy: userId })

    const afterTen = await joinRun(before.id, 1)
    expect(afterTen).toMatchObject({ decision: "open", decidedBy: null, skipCount: 1 })
    expect(afterTen.decidedAt).toBeInstanceOf(Date)
    expect(afterTen.decidedAt?.getTime()).toBeGreaterThan(skipped?.decidedAt?.getTime() ?? 0)
  })

  test("SC822: after a second skip the fix waits 20 more sessions", async () => {
    const before = await savedLearning()
    await db
      .update(learnings)
      .set({
        decision: "skipped",
        decidedAt: new Date(),
        decidedBy: userId,
        skipCount: 2,
        sessionsAtSkip: 3,
      })
      .where(eq(learnings.id, before.id))

    expect(await joinRun(before.id, 21)).toMatchObject({ decision: "skipped" })
    expect(await joinRun(before.id, 1)).toMatchObject({ decision: "open", skipCount: 2 })
  })

  test("SC823: a run that rewrites an accepted fix leaves it accepted", async () => {
    const before = await savedLearning()
    const accepted = await learningsRepo.setDecision(
      db,
      before.id,
      { decision: "accepted" },
      userId,
    )
    const after = await joinRun(before.id, 1, {
      ...written,
      title: "Rewritten by the second run",
      priority: "low",
    })
    expect(after).toMatchObject({
      title: "Rewritten by the second run",
      priority: "low",
      decision: "accepted",
      decidedBy: userId,
      decidedAt: accepted?.decidedAt,
    })
  })

  /** A fix's decision written straight to its row. */
  const setState = (id: string, state: Partial<typeof learnings.$inferInsert>) =>
    db.update(learnings).set(state).where(eq(learnings.id, id))

  /** Fixes made by one finished run, one session and problem each; their ids in order. */
  const savedFixes = async (titles: ReadonlyArray<string>) => {
    for (const title of titles) await seedSession([problem(title)])
    const run = await learningsRepo.startRun(db, projectId)
    const picked = await learningsRepo.unmarkedProblems(db, projectId, 100)
    await learningsRepo.saveBatch(db, {
      runId: run?.id as string,
      projectId,
      groups: titles.map((title) => ({
        cause: `cause of ${title}`,
        learningId: null,
        problemIds: picked.filter((row) => row.title === title).map((row) => row.id),
        answer: { ...written, title },
      })),
    })
    await learningsRepo.finishRun(db, run?.id as string, { status: "done" })
    const rows = await db.select().from(learnings)
    return titles.map((title) => rows.find((row) => row.title === title)?.id as string)
  }

  test("SC831: the grouper's list from the database carries a rejected fix's reason", async () => {
    const [rejected, skipped, open] = await savedFixes(["Rejected", "Skipped", "Open"])
    await learningsRepo.setDecision(
      db,
      rejected as string,
      { decision: "rejected", reason: "not ours" },
      userId,
    )
    await learningsRepo.setDecision(db, skipped as string, { decision: "skipped" }, userId)
    const known = await learningsRepo.learningsForGrouping(db, projectId)
    expect(known).toHaveLength(3)
    expect(Object.fromEntries(known.map((row) => [row.id, row.rejectedReason]))).toEqual({
      [rejected as string]: "not ours",
      [skipped as string]: null,
      [open as string]: null,
    })
  })

  test("SC833: a fix rejected after grouping is still not rewritten", async () => {
    const before = await savedLearning()
    const rejected = await learningsRepo.setDecision(
      db,
      before.id,
      { decision: "rejected", reason: "not ours" },
      userId,
    )
    await seedSession([problem("Late")])
    const run = await learningsRepo.startRun(db, projectId)
    const [late] = await learningsRepo.unmarkedProblems(db, projectId, 10)
    const outcomes = await learningsRepo.saveBatch(db, {
      runId: run?.id as string,
      projectId,
      groups: [
        {
          cause: "x",
          learningId: before.id,
          problemIds: [late?.id as string],
          answer: { ...written, title: "Rewritten anyway", priority: "low" },
        },
      ],
    })
    expect(outcomes).toEqual([
      { action: "linked", learningId: before.id, problemIds: [late?.id as string] },
    ])
    const [after] = await db.select().from(learnings).where(eq(learnings.id, before.id))
    expect(after).toEqual(rejected)
    const [linked] = await db
      .select()
      .from(reviewProblems)
      .where(eq(reviewProblems.id, late?.id as string))
    expect(linked).toMatchObject({ learningId: before.id, linkedQuietly: true })
  })

  test("SC834: the run page neither counts nor lists a quiet link", async () => {
    const [fixB, fixC] = await savedFixes(["B", "C"])
    await learningsRepo.setDecision(
      db,
      fixC as string,
      { decision: "rejected", reason: "not ours" },
      userId,
    )
    for (const title of ["A new", "B more", "C more"]) await seedSession([problem(title)])
    const run = await learningsRepo.startRun(db, projectId)
    const picked = await learningsRepo.unmarkedProblems(db, projectId, 10)
    const idOf = (title: string) => picked.find((row) => row.title === title)?.id as string
    await learningsRepo.saveBatch(db, {
      runId: run?.id as string,
      projectId,
      groups: [
        {
          cause: "a",
          learningId: null,
          problemIds: [idOf("A new")],
          answer: { ...written, title: "A" },
        },
        {
          cause: "b",
          learningId: fixB as string,
          problemIds: [idOf("B more")],
          answer: { ...written, title: "B" },
        },
        {
          cause: "c",
          learningId: fixC as string,
          problemIds: [idOf("C more")],
          answer: { verdict: "link" },
        },
      ],
    })
    await learningsRepo.finishRun(db, run?.id as string, { status: "done" })

    const [latest] = await learningsRepo.listRuns(db, projectId)
    expect(latest).toMatchObject({ id: run?.id, fixesCreated: 1, fixesUpdated: 1 })
    const listed = await learningsRepo.listLearnings(db, projectId, { runId: run?.id as string })
    expect(listed.map((row) => [row.title, row.runMark]).sort()).toEqual([
      ["A", "new"],
      ["B", "updated"],
    ])
    const ofC = await learningsRepo.problemsOfLearning(db, fixC as string)
    expect(ofC.map((row) => row.title).sort()).toEqual(["C", "C more"])
  })

  test("SC835: an earlier run still counts a fix it created that was rejected later", async () => {
    const before = await savedLearning()
    await learningsRepo.setDecision(
      db,
      before.id,
      { decision: "rejected", reason: "not ours" },
      userId,
    )
    await joinRun(before.id, 1, { verdict: "link" })
    const [second, first] = await learningsRepo.listRuns(db, projectId)
    expect(first).toMatchObject({ fixesCreated: 1, fixesUpdated: 0 })
    expect(second).toMatchObject({ fixesCreated: 0, fixesUpdated: 0 })
    const ofFirst = await learningsRepo.listLearnings(db, projectId, { runId: first?.id as string })
    expect(ofFirst.map((row) => [row.id, row.runMark])).toEqual([[before.id, "new"]])
    expect(
      await learningsRepo.listLearnings(db, projectId, { runId: second?.id as string }),
    ).toEqual([])
  })

  test("a fix rejected at grouping but reopened before save is linked quietly, not counted as updated", async () => {
    const before = await savedLearning()
    await joinRun(before.id, 1, { verdict: "link" })
    const [latest] = await learningsRepo.listRuns(db, projectId)
    expect(latest).toMatchObject({ fixesCreated: 0, fixesUpdated: 0 })
    expect(
      await learningsRepo.listLearnings(db, projectId, { runId: latest?.id as string }),
    ).toEqual([])
    const linked = await db
      .select()
      .from(reviewProblems)
      .where(eq(reviewProblems.learningRunId, latest?.id as string))
    expect(linked.map((row) => row.linkedQuietly)).toEqual([true])
  })

  test("SC836: a rejected fix never comes back on its own", async () => {
    const before = await savedLearning()
    await setState(before.id, {
      decision: "rejected",
      decidedAt: new Date(),
      decidedBy: userId,
      rejectReason: "Skipped 3 times",
      skipCount: 3,
      sessionsAtSkip: 2,
    })
    expect(await joinRun(before.id, 30)).toMatchObject({
      decision: "rejected",
      rejectReason: "Skipped 3 times",
    })
  })

  test("SC28: the grouper is still shown a skipped learning, so its cause joins it", async () => {
    const before = await savedLearning()
    await learningsRepo.setDecision(db, before.id, { decision: "skipped" }, userId)
    expect((await learningsRepo.learningsForGrouping(db, projectId)).map((row) => row.id)).toEqual([
      before.id,
    ])
  })

  test("SC809: a Skip records the session count the Fixes card shows", async () => {
    const sessionIds = [
      await seedSession([problem("A")]),
      await seedSession([problem("B")]),
      await seedSession([problem("C")]),
      await seedSession([problem("D")]),
    ]
    const run = await learningsRepo.startRun(db, projectId)
    const picked = await learningsRepo.unmarkedProblems(db, projectId, 10)
    await learningsRepo.saveBatch(db, {
      runId: run?.id as string,
      projectId,
      groups: [
        { cause: "x", learningId: null, problemIds: picked.map((row) => row.id), answer: written },
      ],
    })
    const [fix] = await db.select().from(learnings)
    // One of the four sessions has since moved to another project.
    await db
      .update(sessions)
      .set({ projectId: await newProject(`moved-${counter}`) })
      .where(eq(sessions.id, sessionIds[3] as string))
    const skipped = await learningsRepo.setDecision(
      db,
      fix?.id as string,
      { decision: "skipped" },
      userId,
    )
    expect(skipped).toMatchObject({ decision: "skipped", skipCount: 1, sessionsAtSkip: 3 })
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
  test("SC8: a fix run takes only problems of shown runs: a newer full run hides the older run's problems", async () => {
    counter += 1
    const twice = `learn-session-${counter}`
    await seedSessionFixture(db, {
      sessionId: twice,
      projectId,
      userId,
      problems: [problem("Old")],
    })
    await seedSessionFixture(db, {
      sessionId: twice,
      projectId,
      userId,
      problems: [problem("New")],
    })

    const picked = await learningsRepo.unmarkedProblems(db, projectId, 10)
    expect(picked.map((row) => row.title)).toEqual(["New"])

    const hiddenOnly = await newProject(`hidden-only-${counter}`)
    const other = `learn-session-hidden-${counter}`
    await seedSessionFixture(db, {
      sessionId: other,
      projectId: hiddenOnly,
      userId,
      problems: [problem("Hidden")],
    })
    await seedSessionFixture(db, { sessionId: other, projectId: hiddenOnly, userId, problems: [] })

    await queueDueFixRuns(db)
    const queuedFor = (await db.select().from(learningRuns)).map((run) => run.projectId)
    expect(queuedFor).toContain(projectId)
    expect(queuedFor).not.toContain(hiddenOnly)
  })
})
