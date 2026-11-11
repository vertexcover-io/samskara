import postgres from "postgres"
import { requireDatabaseUrl } from "./db.js"
import { expect, test } from "./fixtures/auth.js"
import { projectId, seedDatabase } from "./seed.js"

const PROJECT = "review-batch-e2e"
const SESSIONS = [
  { id: "review-batch-e2e-one", title: "Batch session one" },
  { id: "review-batch-e2e-two", title: "Batch session two" },
] as const

/**
 * Two sessions that already have a problems review, written straight to the table. Review on
 * ticked sessions skips both, so nothing is queued and no agent runs.
 */
const seedReviewedSessions = async (): Promise<void> => {
  await seedDatabase({
    projects: [{ slug: PROJECT, name: "Batch Project", sessions: [...SESSIONS] }],
  })
  const sql = postgres(requireDatabaseUrl())
  try {
    for (const session of SESSIONS) {
      await sql`
        insert into "sessionReviews" ("sessionId", "projectId", analyzer, outcome, summary, signals)
        values (${session.id}, ${projectId(PROJECT)}, 'ai-problems-v2', 'shipped', 'Clean.',
                ${sql.json({})})
      `
    }
  } finally {
    await sql.end()
  }
}

test("SC28: a person ticks 2 reviewed sessions, presses Review, and is told both already had one", async ({
  authedPage: page,
}) => {
  await seedReviewedSessions()
  await page.goto(`/sessions?project=${projectId(PROJECT)}`)

  for (const session of SESSIONS)
    await page.getByRole("checkbox", { name: `Select ${session.title}` }).check()
  const bar = page.getByRole("region", { name: "Selected sessions" })
  await expect(bar).toContainText("2 selected")

  await bar.getByRole("button", { name: "Review", exact: true }).click()

  await expect(page.getByRole("status")).toHaveText(
    "Queued 0 sessions for review. 2 sessions already had a review.",
  )
  await expect(bar).toContainText("0 selected")
  await expect(page.getByRole("region", { name: "Review progress" })).toHaveCount(0)
})
