import { expect, test } from "./fixtures/auth.js"
import { seedDatabase } from "./seed.js"

const SEED = {
  projects: [
    {
      slug: "samskara",
      name: "Samskara",
      sessions: [
        { id: "e2e-s-1", title: "Port the session detail surface" },
        { id: "e2e-s-2", title: "Wire the auth guard" },
      ],
    },
    {
      slug: "andromeda",
      name: "Andromeda",
      sessions: [{ id: "e2e-s-3", title: "Trim the ingest pipeline" }],
    },
  ],
}

test.beforeEach(async () => {
  await seedDatabase(SEED)
})

test("S14: a signed-in visit to / lands on /projects showing both seeded projects with their counts, and 320px does not scroll horizontally", async ({
  authedPage: page,
}) => {
  await page.goto("/")

  await expect(page).toHaveURL(/\/projects$/)

  const samskara = page.getByRole("link", { name: /Samskara/ })
  const andromeda = page.getByRole("link", { name: /Andromeda/ })
  await expect(samskara).toBeVisible()
  await expect(andromeda).toBeVisible()
  await expect(samskara).toContainText("2")
  await expect(andromeda).toContainText("1")

  await page.setViewportSize({ width: 320, height: 800 })
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)
})

test("S15: an unauthenticated visit to /projects lands on /login with the GitHub link and never paints project data", async ({
  page,
}) => {
  await page.goto("/projects")

  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByRole("link", { name: /continue with github/i })).toBeVisible()
  await expect(page.getByText("Samskara", { exact: true })).toHaveCount(0)
  await expect(page.getByText("Andromeda")).toHaveCount(0)
})
