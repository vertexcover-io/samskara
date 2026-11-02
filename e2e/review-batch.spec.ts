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
 * Two sessions that already have a problems review with no problems, written straight to the
 * table. The batch skips both, and the project's fix run ends at "nothing to do": no agent runs.
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

test("SC26: a person selects 2 sessions, starts a batch, and follows the link to the fixes", async ({
  authedPage: page,
}) => {
  await seedReviewedSessions()
  await page.goto(`/sessions?project=${projectId(PROJECT)}`)

  for (const session of SESSIONS)
    await page.getByRole("checkbox", { name: `Select ${session.title}` }).check()
  const bar = page.getByRole("region", { name: "Selected sessions" })
  await expect(bar).toContainText("2 selected · about 7 min")

  await bar.getByRole("button", { name: "Review and find fixes" }).click()

  const panel = page.getByRole("region", { name: "Review progress" })
  await expect(panel).toContainText("2 skipped (already reviewed)")
  const fixes = panel.getByRole("link", { name: "See fixes for Batch Project" })
  await expect(fixes).toBeVisible()
  await fixes.click()
  await expect(page).toHaveURL(`/learnings?project=${projectId(PROJECT)}`)
})
