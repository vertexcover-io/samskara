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

  // Each row is located by its own project name rather than by a single global text match.
  const primaryRow = page.locator("tr", { hasText: "Primary Sync Project" })
  await expect(primaryRow).toBeVisible()
  await expect(primaryRow.getByText(E2E_USER_LOGIN, { exact: true })).toBeVisible()
  await expect(primaryRow.locator("time")).toBeVisible()

  const secondaryRow = page.locator("tr", { hasText: "Secondary Sync Project" })
  await expect(secondaryRow).toBeVisible()
  await expect(secondaryRow.getByText(E2E_OTHER_USER_LOGIN, { exact: true })).toBeVisible()
  await expect(secondaryRow.locator("time")).toBeVisible()
})

test("SC21: a project filter narrows the table and survives a reload", async ({
  authedPage: page,
}) => {
  await page.goto("/sync-status")
  await expect(page.locator("tr", { hasText: "Secondary Sync Project" })).toBeVisible()

  await page.getByRole("textbox", { name: "Project" }).fill("Primary")

  await expect(page.locator("tr", { hasText: "Primary Sync Project" })).toBeVisible()
  await expect(page.locator("tr", { hasText: "Secondary Sync Project" })).not.toBeVisible()
  await expect(page).toHaveURL(/project=Primary/)

  await page.reload()

  await expect(page.locator("tr", { hasText: "Primary Sync Project" })).toBeVisible()
  await expect(page.locator("tr", { hasText: "Secondary Sync Project" })).not.toBeVisible()
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
