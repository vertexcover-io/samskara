import { expect, test } from "./fixtures/auth.js"
import { E2E_OTHER_USER_LOGIN, E2E_USER_LOGIN, seedDatabase } from "./seed.js"

const SEED = {
  projects: [
    {
      slug: "samskara",
      name: "Samskara",
      sessions: [
        { id: "e2e-s-1", title: "Port the session detail surface" },
        { id: "e2e-s-2", title: "Wire the auth guard", author: "other" as const },
      ],
    },
    {
      slug: "andromeda",
      name: "Andromeda",
      sessions: [{ id: "e2e-s-3", title: "Trim the ingest pipeline" }],
    },
  ],
}

const titles = [
  "Port the session detail surface",
  "Wire the auth guard",
  "Trim the ingest pipeline",
]

test.beforeEach(async () => {
  await seedDatabase(SEED)
})

test("S27: opening a project card filters sessions into the URL, changing the User filter narrows further, Back restores the previous filter set, and reloading that URL reproduces the same rows", async ({
  authedPage: page,
}) => {
  await page.goto("/projects")
  await page.getByRole("button", { name: /Samskara/ }).click()

  await expect(page).toHaveURL(/\/sessions\?project=samskara$/)
  await expect(page.getByRole("button", { name: /Port the session detail surface/ })).toBeVisible()
  await expect(page.getByRole("button", { name: /Wire the auth guard/ })).toBeVisible()
  await expect(page.getByRole("button", { name: /Trim the ingest pipeline/ })).toHaveCount(0)
  await expect(page.getByRole("combobox", { name: /project/i })).toHaveValue("samskara")

  await page.getByRole("combobox", { name: /user/i }).selectOption(E2E_OTHER_USER_LOGIN)

  await expect(page).toHaveURL(
    new RegExp(`/sessions\\?project=samskara&user=${E2E_OTHER_USER_LOGIN}$`),
  )
  await expect(page.getByRole("button", { name: /Wire the auth guard/ })).toBeVisible()
  await expect(page.getByRole("button", { name: /Port the session detail surface/ })).toHaveCount(0)

  await page.goBack()

  await expect(page).toHaveURL(/\/sessions\?project=samskara$/)
  await expect(page.getByRole("combobox", { name: /user/i })).toHaveValue("")
  await expect(page.getByRole("button", { name: /Port the session detail surface/ })).toBeVisible()
  await expect(page.getByRole("button", { name: /Wire the auth guard/ })).toBeVisible()

  await page.goto(`/sessions?project=samskara&user=${E2E_OTHER_USER_LOGIN}`)

  await expect(page.getByRole("button", { name: /Wire the auth guard/ })).toBeVisible()
  await expect(page.getByRole("button", { name: /Port the session detail surface/ })).toHaveCount(0)
  await expect(page.getByRole("combobox", { name: /project/i })).toHaveValue("samskara")
  await expect(page.getByRole("combobox", { name: /user/i })).toHaveValue(E2E_OTHER_USER_LOGIN)
})

test("S27: an unfiltered /sessions lists every readable session, a row opens /sessions/:id, and 320px does not scroll horizontally", async ({
  authedPage: page,
}) => {
  await page.goto("/sessions")

  for (const title of titles) {
    await expect(page.getByRole("button", { name: new RegExp(title) })).toBeVisible()
  }

  await page.setViewportSize({ width: 320, height: 800 })
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)

  await page.getByRole("button", { name: /Port the session detail surface/ }).click()
  await expect(page).toHaveURL(/\/sessions\/e2e-s-1$/)
})

test("S27: a URL naming a project the user cannot read shows the access-withheld state, and the recovery action returns to unfiltered sessions", async ({
  authedPage: page,
}) => {
  await page.goto("/sessions?project=not-a-real-project")

  await expect(page.getByText(/that project cannot be opened/i)).toBeVisible()
  for (const title of titles) {
    await expect(page.getByRole("button", { name: new RegExp(title) })).toHaveCount(0)
  }

  await page.getByRole("button", { name: /back to all sessions/i }).click()

  await expect(page).toHaveURL(/\/sessions$/)
  await expect(page.getByRole("button", { name: /Port the session detail surface/ })).toBeVisible()
})

test("S27: filters that match nothing keep their values and offer a clear action that empties the query string", async ({
  authedPage: page,
}) => {
  await page.goto(`/sessions?project=andromeda&user=${E2E_OTHER_USER_LOGIN}`)

  await expect(page.getByText(/no sessions match these filters/i)).toBeVisible()
  await expect(page.getByRole("combobox", { name: /project/i })).toHaveValue("andromeda")
  await expect(page.getByRole("combobox", { name: /user/i })).toHaveValue(E2E_OTHER_USER_LOGIN)

  await page.getByRole("button", { name: /clear filters/i }).click()

  await expect(page).toHaveURL(/\/sessions$/)
  await expect(page.getByRole("button", { name: new RegExp(titles[0] ?? "") })).toBeVisible()
  await expect(page.getByRole("combobox", { name: /user/i })).toHaveValue("")
})

test("S27: the sessions index shows the primary user's own session under their login, so the User filter is meaningful", async ({
  authedPage: page,
}) => {
  await page.goto(`/sessions?user=${E2E_USER_LOGIN}`)

  await expect(page.getByRole("button", { name: /Port the session detail surface/ })).toBeVisible()
  await expect(page.getByRole("button", { name: /Trim the ingest pipeline/ })).toBeVisible()
  await expect(page.getByRole("button", { name: /Wire the auth guard/ })).toHaveCount(0)
})
