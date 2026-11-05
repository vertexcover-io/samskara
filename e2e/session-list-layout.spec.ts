import { expect, test } from "./fixtures/auth.js"
import { seedDatabase } from "./seed.js"

const MINUTE = 60 * 1000
const DAY = 24 * 60 * MINUTE

// Each row's last-active stamp renders at a different width ("just now", "17 minutes ago", a
// date), which is what used to push the project column to a different x in every row.
const SEED = {
  projects: [
    {
      slug: "layout-alpha",
      name: "Alpha",
      sessions: [
        { id: "layout-just-now", title: "Fresh capture", activeAt: new Date(Date.now()) },
        {
          id: "layout-minutes",
          title: "Recent capture",
          activeAt: new Date(Date.now() - 17 * MINUTE),
        },
      ],
    },
    {
      slug: "layout-beta",
      name: "A much longer project name",
      sessions: [
        { id: "layout-days", title: "Older capture", activeAt: new Date(Date.now() - 12 * DAY) },
        {
          id: "layout-dated",
          title: "Archived capture",
          activeAt: new Date(Date.now() - 400 * DAY),
        },
      ],
    },
  ],
}

test.beforeEach(async () => {
  await seedDatabase(SEED)
})

test("the project names in the session list start at the same x in every row on a wide screen", async ({
  authedPage: page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto("/sessions")

  const titles = ["Fresh capture", "Recent capture", "Older capture", "Archived capture"]
  const projects = ["Alpha", "Alpha", "A much longer project name", "A much longer project name"]

  const lefts = await Promise.all(
    titles.map(async (title, index) => {
      const row = page.getByRole("link").filter({ hasText: title })
      const cell = row.getByText(projects[index] ?? "", { exact: true })
      await expect(cell).toBeVisible()
      const box = await cell.boundingBox()
      return box?.x ?? Number.NaN
    }),
  )

  const first = lefts[0] ?? Number.NaN
  for (const left of lefts) expect(left).toBeCloseTo(first, 0)

  // The stamp column has a fixed width, so the longest stamp ("17 minutes ago") must still fit it.
  const overflowing = await page
    .getByRole("time")
    .evaluateAll((stamps) => stamps.filter((stamp) => stamp.scrollWidth > stamp.clientWidth).length)
  expect(overflowing).toBe(0)
})
