import postgres from "postgres"
import { requireDatabaseUrl } from "./db.js"
import { expect, test } from "./fixtures/auth.js"
import { projectId, seedDatabase } from "./seed.js"

const PROJECT = "fixes-e2e"
const SESSION = "fixes-e2e-session"
const QUOTED_MESSAGE = "7d1c6a52-3f0e-4c1a-9a51-6f1d2b7e8a01"
const TITLE = "Helpers report while their test run is still going"

/**
 * One fix behind one problem: the session and its messages through the shared seed, then a
 * learning run, a review that kept its record order, the problem quoting msg-1, and the
 * learning, written straight to the tables. No agent runs. The learning's problem names a real
 * file path, a word too long to wrap at phone width, the way the writing rules ask a fix to.
 */
const seedFix = async (
  options: {
    readonly project?: string
    readonly story?: Record<string, unknown>
    readonly title?: string
  } = {},
) => {
  const slug = options.project ?? PROJECT
  await seedDatabase({
    projects: [
      {
        slug,
        name: "Fixes Project",
        sessions: [
          {
            id: SESSION,
            title: "Add the search page",
            messages: [
              { msgType: "message", role: "user", content: { text: "Add the search page." } },
              {
                id: QUOTED_MESSAGE,
                msgType: "message",
                role: "assistant",
                content: { text: "Done, the tests are still running in the background." },
              },
            ],
          },
        ],
      },
    ],
  })
  const sql = postgres(requireDatabaseUrl())
  try {
    const project = projectId(slug)
    const [first] =
      await sql`select id from messages where "sessionId" = ${SESSION} and "lineNumber" = 1`
    const recordIds = [first?.id, QUOTED_MESSAGE]
    const [run] = await sql`
      insert into "learningRuns" ("projectId", status, "finishedAt")
      values (${project}, 'done', now()) returning id
    `
    const [review] = await sql`
      insert into "sessionReviews" ("sessionId", "projectId", analyzer, outcome, summary, signals)
      values (${SESSION}, ${project}, 'ai-problems-v2', 'shipped', 's',
              ${sql.json({ run: { recordIds } })})
      returning id
    `
    const [learning] = await sql`
      insert into learnings ("projectId", "updatedByRunId", title, cause, problem, priority,
        "priorityReason", "fixType", fix, impact, "impactReason", "howItHelps", story)
      values (${project}, ${run?.id}, ${options.title ?? TITLE}, 'No wait rule.',
        'Coder agents end their turn while packages/server/src/repositories/learnings.repo.test.ts still runs.', 'high', 'it keeps happening',
        'skill', 'In skills/implement/SKILL.md, wait for the test command to exit.',
        'wrong_result', 'one session shipped code whose tests had not finished',
        'Stops untested work from shipping.',
        ${options.story === undefined ? null : JSON.stringify(options.story)}::jsonb)
      returning id
    `
    await sql`
      insert into "reviewProblems" ("reviewId", "sessionId", "projectId", position, title, class,
        severity, "severityReason", "fixType", description, evidence, learning,
        "learningRunId", "learningId")
      values (${review?.id}, ${SESSION}, ${project}, 0, 'Reported while jest still ran', 'missed',
        'high', 'untested work shipped', 'skill', 'It said done before the tests finished.',
        ${sql.json([{ from: "msg-1", to: "msg-1", quote: "the tests are still running", why: "it reported before they finished" }])},
        'Wait for the run to exit.', ${run?.id}, ${learning?.id})
    `
    return learning?.id as string
  } finally {
    await sql.end()
  }
}

test("SC25: a fix card shows why it matters and wraps a long path on a phone, opens a page whose quote links to the exact message, two columns wide and stacked narrow", async ({
  authedPage: page,
}) => {
  const id = await seedFix()
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`/projects/${projectId(PROJECT)}/fixes?show=10`)

  const card = page.locator("article", { hasText: TITLE })
  await expect(card).toContainText(
    "Why it matters: One session shipped code whose tests had not finished",
  )
  await expect(card).toContainText("Fix: In skills/implement/SKILL.md")
  await expect(card).not.toContainText("Impact:")
  await expect(card).not.toContainText("Stops untested work from shipping.")
  await page.setViewportSize({ width: 390, height: 900 })
  const linesFit = await card
    .locator("p")
    .evaluateAll((lines) => lines.every((line) => line.scrollWidth <= line.clientWidth))
  expect(linesFit).toBe(true)
  await page.setViewportSize({ width: 1280, height: 900 })

  await card.getByRole("link", { name: TITLE }).click()
  await expect(page).toHaveURL(`/learnings/${id}?show=10`)
  const fix = page.getByRole("region", { name: "The fix" })
  const proof = page.getByRole("region", { name: "The proof" })
  await expect(proof.getByRole("heading", { name: /Add the search page/ })).toBeVisible()
  const fixBox = await fix.boundingBox()
  const proofBox = await proof.boundingBox()
  expect(fixBox !== null && proofBox !== null && fixBox.x + fixBox.width <= proofBox.x).toBe(true)

  await page.setViewportSize({ width: 390, height: 900 })
  const narrowFix = await fix.boundingBox()
  const narrowProof = await proof.boundingBox()
  expect(
    narrowFix !== null && narrowProof !== null && narrowFix.y + narrowFix.height <= narrowProof.y,
  ).toBe(true)
  // The page clips what overflows rather than scrolling, so scrollWidth alone misses a box cut off.
  expect(narrowFix !== null && narrowFix.x + narrowFix.width <= 390).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  )

  await proof.getByRole("link", { name: "Open in session" }).click()
  await expect(page).toHaveURL(`/sessions/${SESSION}?tab=conversation&m=${QUOTED_MESSAGE}`)
  await expect(page.locator(`#r-${QUOTED_MESSAGE}`)).toBeInViewport()
})

test("SC37: Skip takes a fix off the list, Show Skipped lists it with Unskip, and Unskip returns it", async ({
  authedPage: page,
}) => {
  await seedFix()
  await page.goto(`/projects/${projectId(PROJECT)}/fixes`)

  const card = page.locator("article", { hasText: TITLE })
  await card.getByRole("button", { name: "Skip" }).click()
  await expect(card).toHaveCount(0)
  await expect(page).toHaveURL(`/projects/${projectId(PROJECT)}/fixes`)

  await page.getByRole("combobox", { name: "Show" }).selectOption("skipped")
  await expect(card).toBeVisible()
  await card.getByRole("button", { name: "Unskip" }).click()
  await expect(page.getByText("No skipped fixes")).toBeVisible()

  await page.getByRole("combobox", { name: "Show" }).selectOption("5")
  await expect(card).toBeVisible()
})

test("the Fixes tab fits a phone when the project has a very long name", async ({
  authedPage: page,
}) => {
  const slug = "fixes-long-name"
  await seedDatabase({
    projects: [
      {
        slug,
        name: "A project with a very long name that a real customer might give to a monorepo workspace",
        sessions: [],
      },
    ],
  })
  await page.setViewportSize({ width: 390, height: 900 })
  await page.goto(`/projects/${projectId(slug)}/fixes`)

  const show = page.getByRole("combobox", { name: "Show" })
  await expect(show).toBeVisible()
  const box = await show.boundingBox()
  expect(box === null ? Number.POSITIVE_INFINITY : box.x + box.width).toBeLessThanOrEqual(390)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
})

const STORY = {
  steps: [
    { text: "A helper started the test suite in the background.", quote: "Add the search page." },
    {
      text: "It reported back before the tests finished.",
      quote: "the tests are still running in the background",
    },
    { text: "The main agent took that as done.", quote: "Done, the tests are still running" },
  ],
  whyProblem: "The change shipped without anyone seeing its tests pass.",
  shouldHave: "The helper should have waited for the tests to finish.",
}

test("SC403/SC404: a fix with a story opens on its example, with every time it happened folded shut until opened, at phone and desktop width", async ({
  authedPage: page,
}) => {
  const project = "fixes-e2e-story"
  const id = await seedFix({ project, story: STORY })

  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(`/learnings/${id}`)

    const example = page.getByRole("region", { name: "An example" })
    await expect(example.getByRole("listitem")).toHaveText([
      /A helper started the test suite.*“Add the search page\.”/,
      /It reported back before the tests finished\..*“the tests are still running/,
      /The main agent took that as done\..*“Done, the tests are still running”/,
    ])
    await expect(example).toContainText(STORY.whyProblem)
    await expect(example).toContainText(STORY.shouldHave)

    const proof = page.getByRole("region", { name: "The proof" })
    await expect(proof).toBeHidden()
    await page.getByText("Every time it happened: 1 problem in 1 session").click()
    await expect(proof.getByRole("heading", { name: /Add the search page/ })).toBeVisible()
    await expect(proof.getByRole("button", { name: "Show messages" })).toBeVisible()
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true)
  }
})

test("a fix title holding a long file path wraps inside the card on the Fixes tab and the run page at phone width", async ({
  authedPage: page,
}) => {
  const slug = "fixes-long-title"
  const title =
    "Agents keep writing packages/server/src/repositories/learnings.repo.integration.test.ts fixtures that read the wall clock"
  await seedFix({ project: slug, title })
  await page.setViewportSize({ width: 390, height: 900 })

  // The page clips what overflows rather than scrolling, so the title's own box is the measure.
  const titleFits = async () => {
    const link = page.getByRole("link", { name: title })
    await expect(link).toBeVisible()
    const box = await link.boundingBox()
    expect(box === null ? Number.POSITIVE_INFINITY : box.x + box.width).toBeLessThanOrEqual(390)
  }

  await page.goto(`/projects/${projectId(slug)}/fixes`)
  await titleFits()

  await page.goto(`/projects/${projectId(slug)}/runs`)
  await page.locator("article").first().getByRole("link").click()
  await expect(page.getByRole("heading", { name: /^Run · / })).toBeVisible()
  await titleFits()
})
