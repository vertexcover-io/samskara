import { readFileSync } from "node:fs"
import type { Sql } from "postgres"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import type { Db } from "./client.js"
import { projects, sessionReviews, sessions, users } from "./schema.js"
import { dockerAvailable, startTestDb } from "./testDb.js"

describe.skipIf(!dockerAvailable())("dropping the old ai-v1 reviews", () => {
  let teardown: () => Promise<void>
  let db: Db
  let client: Sql

  beforeAll(async () => {
    const started = await startTestDb()
    db = started.db
    client = started.client
    teardown = started.teardown
  }, 120_000)

  afterAll(async () => {
    await teardown?.()
  })

  // The migration itself, replayed against rows seeded after it first ran.
  const migration = readFileSync(
    new URL("../../migrations/0034_drop_ai_v1_reviews.sql", import.meta.url),
    "utf8",
  )

  test("DV1: only the ai-v1 rows go; the AI review and the static review stay", async () => {
    const [user] = await db
      .insert(users)
      .values({ githubId: 1, githubLogin: "dev" })
      .returning({ id: users.id })
    const [project] = await db
      .insert(projects)
      .values({ name: "P", slug: "p", ownerUserId: user?.id as string })
      .returning({ id: projects.id })
    const projectId = project?.id as string
    await db
      .insert(sessions)
      .values({ id: "s-1", source: "claude_code", userId: user?.id as string, projectId })
    const review = (analyzer: string) => ({
      sessionId: "s-1",
      projectId,
      analyzer,
      outcome: "productive",
      friction: "none",
      summary: analyzer,
      signals: {},
    })
    await db
      .insert(sessionReviews)
      .values([review("ai-v1"), review("ai-problems-v2"), review("heuristic-v1")])

    await client.unsafe(migration)

    const left = await db.select({ analyzer: sessionReviews.analyzer }).from(sessionReviews)
    expect(left.map((row) => row.analyzer).sort()).toEqual(["ai-problems-v2", "heuristic-v1"])
  })
})
