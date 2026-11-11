import { eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest"
import type { Db } from "../db/client.js"
import { pullRequests, repos, users } from "../db/schema.js"
import { dockerAvailable, startTestDb } from "../db/testDb.js"
import { savePullRequestStates } from "./pullRequests.repo.js"

describe.skipIf(!dockerAvailable())("pull requests: saving the nightly check's answers", () => {
  let db: Db
  let teardown: () => Promise<void>
  let repoId: string

  beforeAll(async () => {
    const started = await startTestDb()
    db = started.db
    teardown = started.teardown
  }, 120_000)

  afterAll(async () => {
    await teardown?.()
  })

  beforeEach(async () => {
    await db.delete(users)
    const [user] = await db
      .insert(users)
      .values({ githubId: 4800, githubLogin: "pr-states-user" })
      .returning({ id: users.id })
    const [repo] = await db
      .insert(repos)
      .values({ host: "github.com", owner: "acme", repoName: "app", ownerUserId: user?.id })
      .returning({ id: repos.id })
    repoId = repo?.id as string
  })

  const openPr = async (number: number): Promise<string> => {
    const [row] = await db
      .insert(pullRequests)
      .values({ repoId, number })
      .returning({ id: pullRequests.id })
    return row?.id as string
  }

  const rowOf = async (id: string) => {
    const [row] = await db.select().from(pullRequests).where(eq(pullRequests.id, id))
    return row
  }

  test("SC14: saved answers update state, close time and check time; other rows are untouched", async () => {
    const merged = await openPr(1)
    const unseen = await openPr(2)
    const untouched = await openPr(3)
    const before = await rowOf(untouched)
    const mergedAt = new Date("2026-11-10T08:00:00Z")
    const checkedAt = new Date("2026-11-11T20:30:00Z")

    const saved = await savePullRequestStates(
      db,
      [
        { id: merged, state: "merged", closedAt: mergedAt },
        { id: unseen, state: null, closedAt: null },
      ],
      checkedAt,
    )

    expect(saved).toBe(2)
    expect(await rowOf(merged)).toMatchObject({ state: "merged", closedAt: mergedAt, checkedAt })
    expect(await rowOf(unseen)).toMatchObject({ state: "open", closedAt: null, checkedAt })
    expect(await rowOf(untouched)).toEqual(before)
  })

  test("an empty answer list writes nothing", async () => {
    const id = await openPr(4)
    const before = await rowOf(id)

    expect(await savePullRequestStates(db, [], new Date())).toBe(0)
    expect(await rowOf(id)).toEqual(before)
  })
})
