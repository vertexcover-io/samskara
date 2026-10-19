import type { Problem } from "@samskara/core"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest"
import type { Db } from "../db/client.js"
import { learningRuns, learnings, reviewProblems, users } from "../db/schema.js"
import { dockerAvailable, startTestDb } from "../db/testDb.js"
import {
  problemFixture,
  seedOrg,
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
} as const

describe.skipIf(!dockerAvailable())("learnings repository", () => {
  let teardown: () => Promise<void>
  let db: Db
  let counter = 0
  let orgId: string
  let userId: string

  /** A session in a project owned by `owner`, with one review holding `problems`. */
  const seedSession = async (problems: ReadonlyArray<Problem>, owner = orgId) => {
    counter += 1
    const sessionId = `learn-session-${counter}`
    await seedSessionFixture(db, { sessionId, orgId: owner, userId, problems })
    return sessionId
  }

  const newOrg = (slug: string): Promise<string> => seedOrg(db, slug)

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
    orgId = await newOrg(`org-${counter}`)
  })

  afterAll(async () => {
    await teardown?.()
  })

  test("LDB1: only one run per org can be running; a second start gets null", async () => {
    const first = await learningsRepo.startRun(db, orgId)
    expect(first?.status).toBe("running")
    expect(await learningsRepo.startRun(db, orgId)).toBeNull()
    await learningsRepo.finishRun(db, first?.id as string, { status: "done" })
    expect(await learningsRepo.startRun(db, orgId)).not.toBeNull()
  })

  test("LDB2: unmarked problems are this org's problems no run has considered, oldest first", async () => {
    await seedSession([problem("First"), problem("Second")])
    await seedSession([problem("Elsewhere")], await newOrg("other-org"))
    const picked = await learningsRepo.unmarkedProblems(db, orgId, 10)
    expect(picked.map((row) => row.title)).toEqual(["First", "Second"])
    expect(picked[0]).toMatchObject({ class: "slow", severity: "medium", fixType: "skill" })
    expect(await learningsRepo.unmarkedProblems(db, orgId, 1)).toHaveLength(1)
  })

  test("LDB3: saving a batch creates learnings, links their problems, and marks every problem", async () => {
    await seedSession([problem("A"), problem("B"), problem("C")])
    const run = await learningsRepo.startRun(db, orgId)
    const [a, b, c] = await learningsRepo.unmarkedProblems(db, orgId, 10)
    await learningsRepo.saveBatch(db, {
      runId: run?.id as string,
      orgId,
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
    expect(await learningsRepo.unmarkedProblems(db, orgId, 10)).toEqual([])
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
    const first = await learningsRepo.startRun(db, orgId)
    const [a] = await learningsRepo.unmarkedProblems(db, orgId, 10)
    await learningsRepo.saveBatch(db, {
      runId: first?.id as string,
      orgId,
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
    const [existing] = await learningsRepo.learningsForGrouping(db, orgId)

    await seedSession([problem("B")])
    const second = await learningsRepo.startRun(db, orgId)
    const [b] = await learningsRepo.unmarkedProblems(db, orgId, 10)
    await learningsRepo.saveBatch(db, {
      runId: second?.id as string,
      orgId,
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
    const run = await learningsRepo.startRun(db, orgId)
    const [a, b, c] = await learningsRepo.unmarkedProblems(db, orgId, 10)
    await learningsRepo.saveBatch(db, {
      runId: run?.id as string,
      orgId,
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
    const list = await learningsRepo.listLearnings(db, orgId)
    expect(list.map((row) => [row.title, row.problemCount, row.sessionCount])).toEqual([
      ["Helpers report while their run is still going", 2, 2],
      ["Low one", 1, 1],
    ])
  })

  test("LDB6: a group whose problems were replaced by a redone review makes no empty learning", async () => {
    await seedSession([problem("A")])
    const run = await learningsRepo.startRun(db, orgId)
    const [a] = await learningsRepo.unmarkedProblems(db, orgId, 10)
    await db.delete(reviewProblems).where(eq(reviewProblems.id, a?.id as string))
    await learningsRepo.saveBatch(db, {
      runId: run?.id as string,
      orgId,
      groups: [{ cause: "x", learningId: null, problemIds: [a?.id as string], answer: written }],
    })
    expect(await db.select().from(learnings)).toEqual([])
  })

  test("LDB7: runs left running by a stopped server are marked failed", async () => {
    const run = await learningsRepo.startRun(db, orgId)
    await learningsRepo.failInterruptedRuns(db)
    const [row] = await db
      .select()
      .from(learningRuns)
      .where(eq(learningRuns.id, run?.id as string))
    expect(row).toMatchObject({ status: "failed", error: "the server stopped during the run" })
  })

  test("LDB8: an org is due when it has unread problems and no run since the cutoff", async () => {
    await seedSession([problem("A")])
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    expect(await learningsRepo.orgsDueForRun(db, weekAgo)).toContain(orgId)
    const run = await learningsRepo.startRun(db, orgId)
    await learningsRepo.finishRun(db, run?.id as string, { status: "failed", error: "x" })
    // A failed run counts: the org waits until the next week.
    expect(await learningsRepo.orgsDueForRun(db, weekAgo)).not.toContain(orgId)
    expect(await learningsRepo.orgsDueForRun(db, new Date(Date.now() + 1000))).toContain(orgId)
  })
})
