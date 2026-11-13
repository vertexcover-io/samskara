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

test("SC701: a click anywhere on a project card opens the project, while View sessions keeps its own place", async ({
  authedPage: page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto("/projects")

  const samskara = page.getByRole("article").filter({ hasText: "Samskara" })
  // The card's stretched link covers the field, so click where a person would rather than on the text node.
  const field = await samskara.getByText("Last active").boundingBox()
  if (field === null) throw new Error("the Last active field is not rendered")
  await page.mouse.click(field.x + field.width / 2, field.y + field.height / 2)
  await expect(page).toHaveURL(`/projects/${projectId("samskara")}`)

  await page.goto("/projects")
  await samskara.getByRole("link", { name: "View 2 sessions" }).click()
  await expect(page).toHaveURL(`/sessions?project=${projectId("samskara")}`)
})

test("the footer stays pinned to the viewport bottom while a long page scrolls under it", async ({
  authedPage: page,
}) => {
  // Enough sessions that the list is several screens tall at this height.
  const sessions = Array.from({ length: 40 }, (_, index) => ({
    id: `e2e-footer-s-${index}`,
    title: `Footer session ${String(index).padStart(2, "0")}`,
  }))
  await seedDatabase({ projects: [{ slug: "footer-long", name: "Footer long", sessions }] })

  await page.setViewportSize({ width: 1280, height: 600 })
  await page.goto("/sessions")
  await expect(page.getByText("Footer session 00")).toBeVisible()

  const footer = page.getByRole("contentinfo")
  const footerBox = async () => {
    const box = await footer.boundingBox()
    if (box === null) throw new Error("footer is not rendered")
    return box
  }

  // The document itself scrolls -- not an inner pane -- so window-relative scrolling keeps working.
  const scrollable = await page.evaluate(
    () => document.documentElement.scrollHeight > document.documentElement.clientHeight,
  )
  expect(scrollable).toBe(true)

  const atTop = await footerBox()
  expect(atTop.y + atTop.height).toBeCloseTo(600, 0)

  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight / 2))
  const midway = await footerBox()
  expect(midway.y + midway.height).toBeCloseTo(600, 0)

  // At the very bottom the last row clears the footer instead of sitting behind it. The list is
  // newest first, and seeded sessions grow newer with their index, so session 00 is the last row.
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
  const atBottom = await footerBox()
  expect(atBottom.y + atBottom.height).toBeCloseTo(600, 0)
  const lastRow = await page.getByText("Footer session 00").boundingBox()
  expect(lastRow).not.toBeNull()
  expect((lastRow?.y ?? 0) + (lastRow?.height ?? 0)).toBeLessThanOrEqual(atBottom.y)
})

test("tabbing down a long page never leaves the focused element behind the pinned footer", async ({
  authedPage: page,
}) => {
  const sessions = Array.from({ length: 40 }, (_, index) => ({
    id: `e2e-footer-focus-s-${index}`,
    title: `Focus session ${String(index).padStart(2, "0")}`,
  }))
  await seedDatabase({ projects: [{ slug: "footer-focus", name: "Footer focus", sessions }] })

  await page.setViewportSize({ width: 1280, height: 600 })
  await page.goto("/sessions")
  await expect(page.getByText("Focus session 00")).toBeVisible()

  // The browser scrolls each newly focused element into view; with the footer pinned over the
  // bottom of the window, that scroll has to stop short of the footer, not at the window's edge.
  const hidden: Array<string> = []
  for (let press = 0; press < 80; press += 1) {
    await page.keyboard.press("Tab")
    const overlap = await page.evaluate(() => {
      const focused = document.activeElement
      const footer = document.querySelector("footer")
      // Once Tab runs off the end of the page, focus rests on <body>, which is not a control.
      if (
        !(focused instanceof HTMLElement) ||
        focused === document.body ||
        footer === null ||
        footer.contains(focused)
      ) {
        return null
      }
      const bottom = focused.getBoundingClientRect().bottom
      const footerTop = footer.getBoundingClientRect().top
      // Half a pixel of slack for sub-pixel rounding between the two rects.
      return bottom > footerTop + 0.5
        ? `${focused.textContent?.trim().slice(0, 40)}: bottom ${bottom}, footer top ${footerTop}`
        : null
    })
    if (overlap !== null) hidden.push(overlap)
  }
  expect(hidden).toEqual([])
})

test("an open filter menu that reaches the pinned footer paints over it", async ({
  authedPage: page,
}) => {
  await page.setViewportSize({ width: 640, height: 600 })
  await page.goto("/sessions")
  await page.getByRole("button", { name: "Show Project suggestions" }).click()
  const menu = page.getByRole("listbox")
  await expect(menu.getByRole("option", { name: "Andromeda" })).toBeVisible()

  // Shorten the window until the footer band covers the menu's bottom 20px, as on a phone held
  // sideways, then ask the browser which of the two is on top there.
  const menuBox = await menu.boundingBox()
  const footerBox = await page.getByRole("contentinfo").boundingBox()
  if (menuBox === null || footerBox === null) throw new Error("menu or footer is not rendered")
  const menuBottom = menuBox.y + menuBox.height
  await page.setViewportSize({ width: 640, height: Math.round(menuBottom + footerBox.height - 20) })
  await expect(menu).toBeVisible()

  const menuOnTop = await page.evaluate(
    ({ x, y }) => {
      const footer = document.querySelector("footer")
      const hit = document.elementFromPoint(x, y)
      const overlapsFooter = footer !== null && y > footer.getBoundingClientRect().top
      return overlapsFooter && hit?.closest("[role=listbox]") !== null
    },
    { x: menuBox.x + 10, y: menuBottom - 8 },
  )
  expect(menuOnTop).toBe(true)
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
