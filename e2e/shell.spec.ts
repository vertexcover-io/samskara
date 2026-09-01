import { expect, test } from "./fixtures/auth.js"
import { projectId, seedDatabase } from "./seed.js"

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

  const samskara = page.getByRole("article").filter({ hasText: "Samskara" })
  const andromeda = page.getByRole("article").filter({ hasText: "Andromeda" })
  await expect(samskara).toBeVisible()
  await expect(andromeda).toBeVisible()
  // The card carries the count; the name inside it links to the project page.
  await expect(samskara).toContainText("2")
  await expect(andromeda).toContainText("1")
  await expect(samskara.getByRole("link", { name: "Samskara" })).toBeVisible()

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

test("SC7: opening a project from the list lands on its page, showing its name and session count", async ({
  authedPage: page,
}) => {
  await page.goto("/projects")

  await page.getByRole("link", { name: /Samskara/ }).click()

  await expect(page).toHaveURL(/\/projects\/[^/]+$/)
  await expect(page.getByRole("heading", { name: "Samskara" })).toBeVisible()
  await expect(page.getByText("2", { exact: true })).toBeVisible()
})

test("SC17: typing the slug deletes the project and returns to the list", async ({
  authedPage: page,
}) => {
  await page.goto("/projects")
  await page.getByRole("link", { name: /Samskara/ }).click()
  await expect(page.getByRole("heading", { name: "Samskara" })).toBeVisible()

  await page.getByRole("button", { name: /delete project/i }).click()
  const dialog = page.getByRole("dialog")
  const confirmButton = dialog.getByRole("button", { name: /delete project/i })
  await expect(confirmButton).toBeDisabled()

  await dialog.getByRole("textbox", { name: /project slug/i }).fill("samskara")
  await expect(confirmButton).toBeEnabled()
  await confirmButton.click()

  await expect(page).toHaveURL(/\/projects$/)
  await expect(page.getByRole("link", { name: /Samskara/ })).toHaveCount(0)
  await expect(page.getByRole("link", { name: /Andromeda/ })).toBeVisible()
})

test("SC24: a project's org owner opens the org page", async ({ authedPage: page }) => {
  await seedDatabase({
    projects: [
      {
        slug: "acme-widget",
        name: "Acme widget",
        org: "acme",
        sessions: [{ id: "e2e-acme-s1", title: "Ship the widget" }],
      },
    ],
    orgMembers: { acme: ["primary"] },
  })

  await page.goto(`/projects/${projectId("acme-widget")}`)
  await page.getByRole("link", { name: /org · acme/i }).click()

  await expect(page).toHaveURL(/\/orgs\/acme$/)
  // level 1, or the org's own project card ("Acme widget") also matches the substring "acme".
  await expect(page.getByRole("heading", { level: 1, name: "acme" })).toBeVisible()
  await expect(page.getByRole("link", { name: /Acme widget/i })).toBeVisible()
})

test("SC31: flipping the auto-add toggle on the org page persists across a reload", async ({
  authedPage: page,
}) => {
  await seedDatabase({
    projects: [
      {
        slug: "acme-widget",
        name: "Acme widget",
        org: "acme",
        sessions: [{ id: "e2e-sc31-s1", title: "Ship the widget" }],
      },
    ],
    orgMembers: { acme: ["primary"] },
    orgAutoAdd: { acme: false },
  })

  await page.goto("/orgs/acme")
  const toggle = page.getByRole("checkbox", { name: /automatically/i })
  await expect(toggle).not.toBeChecked()

  await toggle.click()
  await expect(toggle).toBeChecked()

  // Name and auto-add save together, so a draft only reaches the database on Save.
  await page.getByRole("button", { name: /save/i }).click()
  await expect(page.getByText("Saved")).toBeVisible()

  await page.reload()
  await expect(page.getByRole("checkbox", { name: /automatically/i })).toBeChecked()
})

test("SC40: a super admin registers an org and opens it", async ({ authedPage: page }) => {
  await seedDatabase({ projects: [], superAdmins: ["primary"] })

  await page.goto("/orgs")
  await page.getByRole("textbox", { name: /github org slug/i }).fill("sc40-acme")
  await page.getByRole("button", { name: /register/i }).click()

  const orgLink = page.getByRole("link", { name: /sc40-acme/i })
  await expect(orgLink).toBeVisible()
  await orgLink.click()

  await expect(page).toHaveURL(/\/orgs\/sc40-acme$/)
})
