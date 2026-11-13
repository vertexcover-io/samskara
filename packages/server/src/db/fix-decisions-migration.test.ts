import { readFileSync } from "node:fs"
import { eq } from "drizzle-orm"
import type { Sql } from "postgres"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import * as learningsRepo from "../repositories/learnings.repo.js"
import {
  problemFixture,
  seedOrg,
  seedProject,
  seedSession,
} from "../services/learnings/testFixtures.js"
import type { Db } from "./client.js"
import { learnings, sessions, users } from "./schema.js"
import { dockerAvailable, startTestDb } from "./testDb.js"

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
  story: null,
} as const

describe.skipIf(!dockerAvailable())("the fix decisions backfill migration", () => {
  let teardown: () => Promise<void>
  let db: Db
  let client: Sql

  beforeAll(async () => {
    const started = await startTestDb()
    db = started.db
    client = started.client
    teardown = started.teardown
    // The migration drops the old skip columns after the backfill; put them back so the
    // backfill runs against the shape it was written for.
    await client`alter table "learnings" add column if not exists "skippedAt" timestamp with time zone`
    await client`alter table "learnings" add column if not exists "skippedBy" uuid`
  }, 120_000)

  afterAll(async () => {
    await teardown?.()
  })

  const backfill = () =>
    client.begin(async (tx) => {
      const file = readFileSync(
        new URL("../../migrations/0051_fix_decisions.sql", import.meta.url),
        "utf8",
      )
      // The migration's backfill alone: the columns it adds already exist in a migrated test
      // database.
      const update = file
        .split("--> statement-breakpoint")
        .find((statement) => statement.includes('update "learnings"'))
      await tx.unsafe(update as string)
    })

  test("SC805: the migration turns each old skipped fix into a skipped decision, and a replay changes nothing", async () => {
    const [user] = await db
      .insert(users)
      .values({ githubId: 7101, githubLogin: "old-skipper" })
      .returning()
    const userId = user?.id as string
    const orgId = await seedOrg(db, "backfill-org")
    const projectId = await seedProject(db, orgId, "backfill-project")
    const elsewhere = await seedProject(db, orgId, "backfill-elsewhere")
    for (const [index, title] of ["A1", "A2", "A3", "A4", "B1"].entries())
      await seedSession(db, {
        sessionId: `backfill-${index}`,
        projectId,
        userId,
        problems: [problemFixture(title)],
      })
    const run = await learningsRepo.startRun(db, projectId)
    const picked = await learningsRepo.unmarkedProblems(db, projectId, 10)
    const ids = (titles: ReadonlyArray<string>) =>
      picked.filter((row) => titles.includes(row.title)).map((row) => row.id)
    await learningsRepo.saveBatch(db, {
      runId: run?.id as string,
      projectId,
      groups: [
        {
          cause: "a",
          learningId: null,
          problemIds: ids(["A1", "A2", "A3", "A4"]),
          answer: written,
        },
        { cause: "b", learningId: null, problemIds: ids(["B1"]), answer: written },
      ],
    })
    const rows = await db.select().from(learnings)
    const fixA = rows.find((row) => row.cause === "a")?.id as string
    const fixB = rows.find((row) => row.cause === "b")?.id as string
    // One of A's sessions has since moved to another project.
    await db.update(sessions).set({ projectId: elsewhere }).where(eq(sessions.id, "backfill-3"))
    const skippedAt = new Date("2026-10-20T08:00:00.000Z")
    await client`update "learnings" set "skippedAt" = ${skippedAt.toISOString()}, "skippedBy" = ${userId} where "id" = ${fixA}`

    await backfill()
    const after = async (id: string) =>
      (await db.select().from(learnings).where(eq(learnings.id, id)))[0]
    const a = await after(fixA)
    expect(a).toMatchObject({
      decision: "skipped",
      decidedBy: userId,
      decidedAt: skippedAt,
      skipCount: 1,
      sessionsAtSkip: 3,
      rejectReason: null,
    })
    expect(await after(fixB)).toMatchObject({
      decision: "open",
      decidedAt: null,
      skipCount: 0,
      sessionsAtSkip: null,
    })

    await backfill()
    expect(await after(fixA)).toEqual(a)
  })
})
