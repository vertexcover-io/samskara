import { expect, test } from "./fixtures/auth.js"
import { E2E_OTHER_USER_LOGIN, E2E_USER_LOGIN, seedDatabase } from "./seed.js"

const SEED = {
  projects: [
    {
      slug: "sync-status-primary",
      name: "Primary Sync Project",
      sessions: [{ id: "sync-status-e2e-primary", title: "Primary capture" }],
    },
    {
      slug: "sync-status-secondary",
      name: "Secondary Sync Project",
      owner: "other" as const,
      sessions: [
        { id: "sync-status-e2e-secondary", title: "Secondary capture", author: "other" as const },
      ],
    },
  ],
}

test.beforeEach(async () => {
  await seedDatabase(SEED)
})

test("SC13: a signed-in visit follows the Sync nav link to /sync-status and lists both seeded users with their projects and sync times", async ({
  authedPage: page,
}) => {
  await page.goto("/projects")

  await page.getByRole("link", { name: "Sync", exact: true }).click()
  await expect(page).toHaveURL(/\/sync-status$/)

  // The shared e2e database accumulates other specs' projects for these two users, so each
  // row is found by its own project name rather than asserting a single global text match.
  const primaryRow = page.locator("tr", { hasText: "Primary Sync Project" })
  await expect(primaryRow).toBeVisible()
  await expect(primaryRow.getByText(E2E_USER_LOGIN, { exact: true })).toBeVisible()
  await expect(primaryRow.locator("time")).toBeVisible()

  const secondaryRow = page.locator("tr", { hasText: "Secondary Sync Project" })
  await expect(secondaryRow).toBeVisible()
  await expect(secondaryRow.getByText(E2E_OTHER_USER_LOGIN, { exact: true })).toBeVisible()
  await expect(secondaryRow.locator("time")).toBeVisible()
})
