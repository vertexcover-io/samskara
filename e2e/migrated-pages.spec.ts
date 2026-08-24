import { expect, test } from "./fixtures/auth.js"
import { E2E_USER_LOGIN, projectId, seedDatabase } from "./seed.js"

// A project slug of its own, not the shared "samskara" fixture other specs reuse: the sync
// status table accumulates rows across specs sharing this database, so a distinct name is what
// lets this test find its own row rather than one of several matching "Samskara".
const SEED = {
  projects: [
    {
      slug: "migrated-pages-e2e",
      name: "Migrated Pages Regression",
      sessions: [
        {
          id: "e2e-migrated-1",
          title: "Verify the inferred API contract",
          messages: [
            {
              msgType: "message",
              role: "user",
              content: { text: "Confirm the migration holds end to end" },
            },
          ],
        },
      ],
    },
  ],
}

test.beforeEach(async () => {
  await seedDatabase(SEED)
})

test("SC26 (regression): every migrated page loads its data through the inferred client contract", async ({
  authedPage: page,
}) => {
  // The projects page lists projects.
  await page.goto("/projects")
  await expect(page.getByRole("link", { name: /Migrated Pages Regression/ })).toBeVisible()

  // The sessions page lists sessions.
  await page.getByRole("link", { name: /Migrated Pages Regression/ }).click()
  await expect(page).toHaveURL(
    new RegExp(`/sessions\\?project=${projectId("migrated-pages-e2e")}$`),
  )
  await expect(page.getByRole("link", { name: /Verify the inferred API contract/ })).toBeVisible()

  // A session detail page opens and shows its transcript.
  await page.getByRole("link", { name: /Verify the inferred API contract/ }).click()
  await expect(page).toHaveURL(/\/sessions\/e2e-migrated-1$/)
  await expect(page.getByText(/Confirm the migration holds end to end/)).toBeVisible()

  // The sync status page lists rows.
  await page.goto("/sync-status")
  await expect(page.locator("tr", { hasText: "Migrated Pages Regression" })).toBeVisible()

  // The account menu shows the signed-in user.
  await page.getByRole("button", { name: "Account menu", exact: true }).click()
  await expect(page.getByRole("menu").getByText(E2E_USER_LOGIN)).toBeVisible()
})
