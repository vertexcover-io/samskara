import { expect, test } from "./fixtures/auth.js"
import { E2E_OTHER_USER_LOGIN, E2E_USER_LOGIN, seedDatabase } from "./seed.js"

// The secondary project is org-owned with both users in the org: the table is scoped to what the
// signed-in user may read, so a colleague's row only exists where a shared project puts it there.
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
      org: "sync-status-org",
      sessions: [
        { id: "sync-status-e2e-secondary", title: "Secondary capture", author: "other" as const },
      ],
    },
  ],
  orgMembers: { "sync-status-org": ["primary", "other"] as const },
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

  // Each row is located by its own project name rather than by a single global text match.
  const primaryRow = page.locator("tr", { hasText: "Primary Sync Project" })
  await expect(primaryRow).toBeVisible()
  await expect(primaryRow.getByText(E2E_USER_LOGIN, { exact: true })).toBeVisible()
  await expect(primaryRow.locator("time")).toBeVisible()

  // The org project pairs with both members, so the colleague's row is picked out by their login.
  const secondaryRow = page
    .locator("tr", { hasText: "Secondary Sync Project" })
    .filter({ hasText: E2E_OTHER_USER_LOGIN })
  await expect(secondaryRow).toBeVisible()
  await expect(secondaryRow.locator("time")).toBeVisible()
})

test("SC21: a project filter narrows the table and survives a reload", async ({
  authedPage: page,
}) => {
  await page.goto("/sync-status")
  await expect(page.locator("tr", { hasText: "Secondary Sync Project" }).first()).toBeVisible()

  await page.getByRole("combobox", { name: "Project" }).fill("Primary")
  await page.getByRole("option", { name: "Primary Sync Project" }).click()

  await expect(page.locator("tr", { hasText: "Primary Sync Project" })).toBeVisible()
  await expect(page.locator("tr", { hasText: "Secondary Sync Project" })).toHaveCount(0)
  await expect(page).toHaveURL(/project=Primary\+Sync\+Project/)

  await page.reload()

  await expect(page.locator("tr", { hasText: "Primary Sync Project" })).toBeVisible()
  await expect(page.locator("tr", { hasText: "Secondary Sync Project" })).toHaveCount(0)
})

test("SC22: the table does not scroll sideways on a narrow screen", async ({
  authedPage: page,
}) => {
  await page.setViewportSize({ width: 320, height: 800 })
  await page.goto("/sync-status")
  await expect(page.locator("tr", { hasText: "Primary Sync Project" })).toBeVisible()

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)

  for (const label of ["User", "Project", "Sessions", "Last synced"]) {
    await expect(page.getByRole("columnheader", { name: label })).toBeVisible()
  }
})
