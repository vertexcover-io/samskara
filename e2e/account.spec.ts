import { expect, test } from "./fixtures/auth.js"
import { seedDatabase } from "./seed.js"

const SEED = {
  projects: [
    {
      slug: "samskara",
      name: "Samskara",
      sessions: [{ id: "e2e-a-1", title: "Pair the CLI from the account menu" }],
    },
  ],
}

test.beforeEach(async () => {
  await seedDatabase(SEED)
})

test("S36: the account menu mints a real 32-char hex pairing code with Copy and no expiry, and logging out lands on /login where a /projects reload shows no project data", async ({
  authedPage: page,
}) => {
  await page.goto("/projects")

  await page.getByRole("button", { name: "Account menu", exact: true }).click()
  await page.getByRole("menuitem", { name: /pair the cli/i }).click()

  const dialog = page.getByRole("dialog", { name: "Pair the CLI" })
  await expect(dialog).toBeVisible()

  await dialog.getByRole("button", { name: /generate code/i }).click()

  await expect(dialog.getByTestId("pairing-code")).toHaveText(/^[0-9a-f]{32}$/)
  await expect(dialog.getByText(/expires/i)).toHaveCount(0)
  await expect(dialog.getByRole("button", { name: /^copy$/i })).toBeVisible()

  await dialog.getByRole("button", { name: /close/i }).click()
  await expect(dialog).toBeHidden()

  await page.getByRole("button", { name: "Account menu", exact: true }).click()
  await page.getByRole("menuitem", { name: /log out/i }).click()

  await expect(page).toHaveURL(/\/login$/)

  await page.goto("/projects")
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByText("Samskara", { exact: true })).toHaveCount(0)
})

test("NF2 S36: the account menu declaring role=menu is arrow-key navigable - opening focuses the first item and Arrow/Home/End move between them", async ({
  authedPage: page,
}) => {
  await page.goto("/projects")

  const trigger = page.getByRole("button", { name: "Account menu", exact: true })
  await trigger.focus()
  await page.keyboard.press("Enter")

  const pair = page.getByRole("menuitem", { name: /pair the cli/i })
  const logout = page.getByRole("menuitem", { name: /log out/i })

  await expect(pair).toBeFocused()

  await page.keyboard.press("ArrowDown")
  await expect(logout).toBeFocused()

  await page.keyboard.press("ArrowDown")
  await expect(pair).toBeFocused()

  await page.keyboard.press("ArrowUp")
  await expect(logout).toBeFocused()

  await page.keyboard.press("Home")
  await expect(pair).toBeFocused()

  await page.keyboard.press("End")
  await expect(logout).toBeFocused()

  await page.keyboard.press("Escape")
  await expect(page.getByRole("menu")).toHaveCount(0)
  await expect(trigger).toBeFocused()
})

test("REQ-013 S36: Escape from the pairing dialog returns focus to the account menu trigger - not to the document body its unmounted opener leaves behind", async ({
  authedPage: page,
}) => {
  await page.goto("/projects")

  const trigger = page.getByRole("button", { name: "Account menu", exact: true })
  await trigger.click()
  await page.getByRole("menuitem", { name: /pair the cli/i }).click()

  const dialog = page.getByRole("dialog", { name: "Pair the CLI" })
  await expect(dialog).toBeVisible()
  await expect(page.getByRole("menuitem")).toHaveCount(0)

  await page.keyboard.press("Escape")

  await expect(dialog).toHaveCount(0)
  await expect(trigger).toBeFocused()

  await trigger.click()
  await page.getByRole("menuitem", { name: /pair the cli/i }).click()
  await expect(dialog).toBeVisible()
  await dialog.getByRole("button", { name: /^close$/i }).click()

  await expect(dialog).toHaveCount(0)
  await expect(trigger).toBeFocused()
})
