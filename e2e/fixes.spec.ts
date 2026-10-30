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
const seedFix = async () => {
  await seedDatabase({
    projects: [
      {
        slug: PROJECT,
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
    const project = projectId(PROJECT)
    const [first] =
      await sql`select id from messages where "sessionId" = ${SESSION} and "lineNumber" = 1`
    const recordIds = [first?.id, QUOTED_MESSAGE]
    const [run] = await sql`
      insert into "learningRuns" ("projectId", status, "finishedAt")
      values (${project}, 'done', now()) returning id
    `
    const [review] = await sql`
      insert into "sessionReviews" ("sessionId", "projectId", analyzer, outcome, friction, summary, signals)
      values (${SESSION}, ${project}, 'ai-problems-v2', 'shipped', 'none', 's',
              ${sql.json({ run: { recordIds } })})
      returning id
    `
    const [learning] = await sql`
      insert into learnings ("projectId", "updatedByRunId", title, cause, problem, priority,
        "priorityReason", "fixType", fix, impact, "impactReason", "howItHelps")
      values (${project}, ${run?.id}, ${TITLE}, 'No wait rule.',
        'Coder agents end their turn while packages/server/src/repositories/learnings.repo.test.ts still runs.', 'high', 'it keeps happening',
        'skill', 'In skills/implement/SKILL.md, wait for the test command to exit.',
        'wrong_result', 'one session shipped code whose tests had not finished',
        'Stops untested work from shipping.')
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

test("SC25: a fix card shows its impact and wraps a long path on a phone, opens a page whose quote links to the exact message, two columns wide and stacked narrow", async ({
  authedPage: page,
}) => {
  const id = await seedFix()
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`/learnings?project=${projectId(PROJECT)}&show=10`)

  const card = page.locator("article", { hasText: TITLE })
  await expect(card.getByText("Impact: Wrong result.")).toBeVisible()
  await expect(card.getByText("Stops untested work from shipping.")).toBeVisible()
  await page.setViewportSize({ width: 390, height: 900 })
  const linesFit = await card
    .locator("p")
    .evaluateAll((lines) => lines.every((line) => line.scrollWidth <= line.clientWidth))
  expect(linesFit).toBe(true)
  await page.setViewportSize({ width: 1280, height: 900 })

  await card.getByRole("link", { name: TITLE }).click()
  await expect(page).toHaveURL(`/learnings/${id}?project=${projectId(PROJECT)}&show=10`)
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

  await proof.getByRole("link", { name: "Open message" }).click()
  await expect(page).toHaveURL(`/sessions/${SESSION}?tab=conversation&m=${QUOTED_MESSAGE}`)
  await expect(page.locator(`#r-${QUOTED_MESSAGE}`)).toBeInViewport()
})

test("SC37: Skip takes a fix off the list, Show Skipped lists it with Unskip, and Unskip returns it", async ({
  authedPage: page,
}) => {
  await seedFix()
  await page.goto(`/learnings?project=${projectId(PROJECT)}`)

  const card = page.locator("article", { hasText: TITLE })
  await card.getByRole("button", { name: "Skip" }).click()
  await expect(card).toHaveCount(0)
  await expect(page).toHaveURL(/\/learnings\?/)

  await page.getByRole("combobox", { name: "Show" }).selectOption("skipped")
  await expect(card).toBeVisible()
  await card.getByRole("button", { name: "Unskip" }).click()
  await expect(page.getByText("No skipped fixes")).toBeVisible()

  await page.getByRole("combobox", { name: "Show" }).selectOption("5")
  await expect(card).toBeVisible()
})
