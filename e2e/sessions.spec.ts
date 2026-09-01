import type { Page } from "@playwright/test"
import { expect, mintSessionToken, test } from "./fixtures/auth.js"
import {
  E2E_OTHER_USER_ID,
  E2E_OTHER_USER_LOGIN,
  E2E_USER_LOGIN,
  projectId,
  seedDatabase,
} from "./seed.js"

const VISIBLE_REPOSITORY = "samskara"
const HIDDEN_REPOSITORY = "sealed"
const VISIBLE_SHA = "aabbccddeeff00112233445566778899aabbccdd"

const paginationSessions = Array.from({ length: 51 }, (_, index) => ({
  id: `page-${String(index + 1).padStart(2, "0")}`,
  title: `Pagination ledger ${String(index + 1).padStart(2, "0")}`,
}))

const SEED = {
  repositories: [
    { key: VISIBLE_REPOSITORY, host: "github.com", owner: "acme", repoName: "samskara" },
    {
      key: HIDDEN_REPOSITORY,
      host: "github.com",
      owner: "acme",
      repoName: "sealed",
      ownerUser: "other" as const,
    },
  ],
  projects: [
    {
      slug: "samskara",
      name: "Samskara",
      sessions: [
        { id: "keyword-session-id-beacon", title: "Routine maintenance" },
        { id: "keyword-session-title", title: "Title evidence lantern" },
        {
          id: "keyword-message-id",
          title: "Conversation identifier evidence",
          messages: [
            {
              id: "11111111-1111-4111-8111-111111111111",
              msgType: "message",
              content: { text: "ordinary note" },
            },
          ],
        },
        {
          id: "keyword-message-content",
          title: "Conversation content evidence",
          messages: [{ msgType: "message", content: { text: "message-content-citrine" } }],
        },
        {
          id: "keyword-message-details",
          title: "Conversation details evidence",
          messages: [{ msgType: "message", details: { observation: "message-details-vermilion" } }],
        },
        {
          id: "keyword-pr-title",
          title: "Pull request evidence",
          pullRequests: [
            {
              repository: VISIBLE_REPOSITORY,
              number: 42,
              title: "PR-title-cerulean",
              baseBranch: "main",
              headBranch: "feature/search",
            },
          ],
        },
        {
          id: "keyword-tool-call-id",
          title: "Tool call identifier evidence",
          messages: [
            {
              msgType: "toolCall",
              tool: { toolId: "tool-call-id-amber", toolName: "Bash", toolInput: {} },
            },
          ],
        },
        {
          id: "keyword-tool-call-input",
          title: "Tool call input evidence",
          messages: [
            {
              msgType: "toolCall",
              tool: {
                toolId: "ordinary-call",
                toolName: "Bash",
                toolInput: { command: "tool-call-input-indigo" },
              },
            },
          ],
        },
        {
          id: "keyword-tool-result-id",
          title: "Tool result identifier evidence",
          messages: [
            {
              msgType: "toolResult",
              tool: {
                toolId: "tool-result-id-rose",
                toolName: "Bash",
                toolInput: { note: "ordinary input" },
                result: { text: "ordinary result" },
              },
            },
          ],
        },
        {
          id: "keyword-tool-result-body",
          title: "Tool result body evidence",
          messages: [
            {
              msgType: "toolResult",
              tool: {
                toolId: "ordinary-result",
                toolName: "Bash",
                toolInput: {},
                result: { text: "tool-result-body-violet" },
              },
            },
          ],
        },
        {
          id: "structured-message",
          title: "Structured message association",
          messages: [
            {
              msgType: "message",
              repository: VISIBLE_REPOSITORY,
              gitBranch: "feature/search",
              content: { text: "combined-needle" },
            },
          ],
        },
        {
          id: "structured-commit",
          title: "Structured commit association",
          commits: [{ repository: VISIBLE_REPOSITORY, sha: VISIBLE_SHA, branch: "release/search" }],
        },
        {
          id: "structured-pr",
          title: "Structured pull request association",
          commits: [
            {
              repository: VISIBLE_REPOSITORY,
              sha: "aabbccd012345678901234567890123456789012",
              branch: "support/search",
            },
          ],
          pullRequests: [
            {
              repository: VISIBLE_REPOSITORY,
              number: 73,
              title: "Opened filter PR",
              baseBranch: "stable",
              headBranch: "feature/pr-filter",
            },
          ],
        },
        { id: "other-author", title: "Wire the auth guard", author: "other" as const },
        ...paginationSessions,
      ],
    },
    {
      slug: "andromeda",
      name: "Andromeda",
      sessions: [{ id: "andromeda-session", title: "Trim the ingest pipeline" }],
    },
    {
      slug: "acme-widget",
      name: "acme-widget",
      org: "acme",
      sessions: [{ id: "acme-widget-session", title: "Acme widget session" }],
    },
    {
      slug: "sealed-project",
      name: "Sealed project",
      owner: "other" as const,
      sessions: [
        {
          id: "hidden-evidence",
          title: "Hidden title evidence lantern",
          messages: [
            {
              msgType: "message",
              repository: HIDDEN_REPOSITORY,
              gitBranch: "feature/search",
              content: { text: "message-content-citrine combined-needle" },
            },
          ],
          commits: [
            {
              repository: HIDDEN_REPOSITORY,
              sha: "aabbccddeadbeef00112233445566778899aabbcc",
              branch: "release/search",
            },
          ],
          pullRequests: [
            {
              repository: HIDDEN_REPOSITORY,
              number: 42,
              title: "PR-title-cerulean",
              baseBranch: "stable",
              headBranch: "feature/pr-filter",
            },
          ],
        },
      ],
    },
  ],
}

const search = async (page: Page, query: string): Promise<void> => {
  await page.getByRole("searchbox", { name: /search session evidence/i }).fill(query)
  await page.getByRole("button", { name: "Search", exact: true }).click()
}

const expectOnlySession = async (page: Page, title: string): Promise<void> => {
  await expect(page.getByRole("link", { name: new RegExp(title) })).toBeVisible()
  await expect(page.getByRole("link", { name: /Hidden title evidence lantern/ })).toHaveCount(0)
}

test.beforeEach(async () => {
  await seedDatabase(SEED)
})

test("keyword search finds only the approved session, message, PR, and tool sources with source evidence", async ({
  authedPage: page,
}) => {
  await page.goto("/sessions")

  const cases = [
    ["keyword-session-id-beacon", "Routine maintenance", "Session"],
    ["lantern", "Title evidence lantern", "Session"],
    ["11111111", "Conversation identifier evidence", "Conversation"],
    ["message-content-citrine", "Conversation content evidence", "Conversation"],
    ["message-details-vermilion", "Conversation details evidence", "Conversation"],
    ["pr-title-cerulean", "Pull request evidence", "Pull request"],
    ["tool-call-id-amber", "Tool call identifier evidence", "Tool call"],
    ["tool-call-input-indigo", "Tool call input evidence", "Tool call"],
    // Tool-result IDs share their tool-call ID; fixed source precedence therefore shows the call snippet.
    ["tool-result-id-rose", "Tool result identifier evidence", "Tool call"],
    ["tool-result-body-violet", "Tool result body evidence", "Tool result"],
  ] as const

  for (const [query, title, source] of cases) {
    await search(page, query)
    await expectOnlySession(page, title)
    const row = page.getByRole("link", { name: new RegExp(title) })
    await expect(row.getByText(source, { exact: true })).toBeVisible()
    expect(await row.locator("mark").count()).toBeGreaterThan(0)
  }
})

test("repository, branch, PR number, and full or unique-prefix commit controls narrow sessions", async ({
  authedPage: page,
}) => {
  await page.goto("/sessions")

  await page.getByRole("combobox", { name: "Repository" }).selectOption({ label: "acme/samskara" })
  await expect(page.getByRole("link", { name: /Structured message association/ })).toBeVisible()
  await expect(page.getByRole("link", { name: /Structured commit association/ })).toBeVisible()
  await expect(
    page.getByRole("link", { name: /Structured pull request association/ }),
  ).toBeVisible()

  await page.getByRole("combobox", { name: "Branch" }).selectOption("release/search")
  await expectOnlySession(page, "Structured commit association")

  await page.getByRole("combobox", { name: "Branch" }).selectOption("")
  await page.getByRole("textbox", { name: "PR number" }).fill("73")
  await page.getByRole("textbox", { name: "PR number" }).press("Enter")
  await expectOnlySession(page, "Structured pull request association")

  await page.getByRole("textbox", { name: "PR number" }).fill("")
  await page.getByRole("textbox", { name: "PR number" }).press("Enter")
  await expect(page).not.toHaveURL(/pr=73/)
  await expect(page.getByRole("link", { name: /Structured commit association/ })).toBeVisible()

  await page
    .getByRole("textbox", { name: "Commit SHA" })
    .fill(VISIBLE_SHA.slice(0, 12).toUpperCase())
  await page.getByRole("textbox", { name: "Commit SHA" }).press("Enter")
  await expect(page).toHaveURL(new RegExp(`commit=${VISIBLE_SHA.slice(0, 12)}`))
  await expectOnlySession(page, "Structured commit association")
})

test("keyword and structured filters combine with AND while authorized vocabulary ignores active filters", async ({
  authedPage: page,
}) => {
  await page.goto("/sessions")
  await search(page, "combined-needle")
  await expectOnlySession(page, "Structured message association")

  await expect(
    page.getByRole("combobox", { name: "Project" }).getByRole("option", { name: "Samskara" }),
  ).toBeAttached()
  await expect(
    page.getByRole("combobox", { name: "Project" }).getByRole("option", { name: "Andromeda" }),
  ).toBeAttached()
  await expect(
    page.getByRole("combobox", { name: "User" }).getByRole("option", { name: E2E_USER_LOGIN }),
  ).toBeAttached()
  await expect(
    page
      .getByRole("combobox", { name: "User" })
      .getByRole("option", { name: E2E_OTHER_USER_LOGIN }),
  ).toBeAttached()
  await expect(
    page
      .getByRole("combobox", { name: "Repository" })
      .getByRole("option", { name: "acme/samskara" }),
  ).toBeAttached()
  await expect(
    page.getByRole("combobox", { name: "Repository" }).getByRole("option", { name: "acme/sealed" }),
  ).toHaveCount(0)
  for (const branch of ["feature/search", "release/search", "feature/pr-filter"]) {
    await expect(
      page.getByRole("combobox", { name: "Branch" }).getByRole("option", { name: branch }),
    ).toBeAttached()
  }

  await page.getByRole("combobox", { name: "Project" }).selectOption(projectId("samskara"))
  await page.getByRole("combobox", { name: "User" }).selectOption(E2E_USER_LOGIN)
  await page.getByRole("combobox", { name: "Repository" }).selectOption({ label: "acme/samskara" })
  await page.getByRole("combobox", { name: "Branch" }).selectOption("feature/search")
  await page.getByRole("textbox", { name: "PR number" }).fill("42")
  await page.getByRole("textbox", { name: "PR number" }).press("Enter")

  await expect(page.getByText(/no sessions match these filters/i)).toBeVisible()
  await page.getByRole("textbox", { name: "PR number" }).fill("")
  await page.getByRole("textbox", { name: "PR number" }).press("Enter")
  await expectOnlySession(page, "Structured message association")
})

test("relevance evidence, pagination, clear-search reset, reload, and browser history preserve URL state", async ({
  authedPage: page,
}) => {
  await page.goto("/sessions")
  await search(page, "ledger")
  await expect(page.getByRole("link", { name: /Pagination ledger 51/ })).toBeVisible()
  await expect(page.getByText(/Page 1 of 2/)).toBeVisible()
  await page.getByRole("button", { name: "Next" }).click()
  await expect(page).toHaveURL(/q=ledger.*page=2|page=2.*q=ledger/)
  await expect(page.getByText(/Page 2 of 2/)).toBeVisible()
  await expect(page.getByRole("link", { name: /Pagination ledger 01/ })).toBeVisible()

  await page.reload()
  await expect(page.getByText(/Page 2 of 2/)).toBeVisible()
  await page.goBack()
  await expect(page.getByText(/Page 1 of 2/)).toBeVisible()
  await page.goForward()
  await expect(page.getByText(/Page 2 of 2/)).toBeVisible()

  await page.getByRole("button", { name: "Clear search" }).click()
  await expect(page).toHaveURL(/\/sessions$/)
  await expect(page.getByRole("combobox", { name: "Sort by" })).toHaveValue("recent")
})

test("Today and custom local-date filters serialize the browser timezone and preserve it on reload", async ({
  authedPage: page,
}) => {
  const timeZone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)

  await page.goto("/sessions?range=today")
  await expect(page.getByRole("combobox", { name: "Last active" })).toHaveValue("today")
  await expect.poll(() => new URL(page.url()).searchParams.get("tz")).toBe(timeZone)

  await page.reload()
  await expect(page.getByRole("combobox", { name: "Last active" })).toHaveValue("today")
  await expect.poll(() => new URL(page.url()).searchParams.get("tz")).toBe(timeZone)

  await page.getByRole("combobox", { name: "Last active" }).selectOption("custom")
  await page.getByRole("textbox", { name: "From date" }).fill("2026-02-01")
  await page.getByRole("textbox", { name: "To date" }).fill("2026-02-02")
  await expect
    .poll(() => {
      const params = new URL(page.url()).searchParams
      return [params.get("range"), params.get("from"), params.get("to"), params.get("tz")]
    })
    .toEqual(["custom", "2026-02-01", "2026-02-02", timeZone])

  await page.reload()
  await expect(page.getByRole("textbox", { name: "From date" })).toHaveValue("2026-02-01")
  await expect(page.getByRole("textbox", { name: "To date" })).toHaveValue("2026-02-02")
  await expect.poll(() => new URL(page.url()).searchParams.get("tz")).toBe(timeZone)
})

test("invalid filters and ambiguous authorized commit prefixes explain the state without exposing hidden data", async ({
  authedPage: page,
}) => {
  await page.goto("/sessions?pr=01")
  await expect(page.getByRole("alert")).toContainText(/check your search or filter/i)

  await page.goto("/sessions?q=OR")
  await expect(page.getByRole("alert")).toContainText(/check your search or filter/i)

  // Two authorized commits share this prefix, so it is ambiguous without considering the hidden SHA.
  await page.goto(`/sessions?commit=${VISIBLE_SHA.slice(0, 7)}`)
  await expect(page.getByRole("alert")).toContainText(/commit prefix is ambiguous/i)

  // The longer visible prefix remains unique even though the inaccessible project has the short prefix.
  await page.goto(`/sessions?commit=${VISIBLE_SHA.slice(0, 12)}`)
  await expectOnlySession(page, "Structured commit association")
})

test("SC35: project links use accessible link semantics, filters restore through history, and narrow layout has no horizontal overflow", async ({
  authedPage: page,
}) => {
  await page.goto("/projects")
  await page.getByRole("link", { name: /Samskara/ }).click()

  // A project card opens the project page; the session list is one link further on.
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId("samskara")}$`))
  await page.getByRole("link", { name: /all \d+ sessions/i }).click()
  await expect(page).toHaveURL(new RegExp(`/sessions\\?project=${projectId("samskara")}$`))
  await expect(page.getByRole("link", { name: /Pagination ledger 51/ })).toBeVisible()
  await page.getByRole("combobox", { name: "User" }).selectOption(E2E_OTHER_USER_LOGIN)
  await expect(page.getByRole("link", { name: /Wire the auth guard/ })).toBeVisible()

  await page.goBack()
  await expect(page.getByRole("combobox", { name: "User" })).toHaveValue("")
  await expect(page.getByRole("link", { name: /Pagination ledger 51/ })).toBeVisible()

  await page.setViewportSize({ width: 320, height: 800 })
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)
})

test("SC34: clicking an org project card opens its project page, and the card shows the org", async ({
  authedPage: page,
}) => {
  await page.goto("/projects")

  const acmeWidgetCard = page.locator(`a[href="/projects/${projectId("acme-widget")}"]`)
  await expect(acmeWidgetCard).toContainText("acme")

  await acmeWidgetCard.click()
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId("acme-widget")}$`))

  await page.getByRole("link", { name: /all \d+ sessions/i }).click()
  await expect(page).toHaveURL(new RegExp(`/sessions\\?project=${projectId("acme-widget")}$`))
  await expect(page.getByRole("link", { name: /Acme widget session/i })).toBeVisible()
})

test("SC8: a member sees the org's project card; a non-member does not", async ({
  authedPage: page,
  context,
}) => {
  // Matched by href rather than accessible name: a dev database can carry an unrelated
  // "acme-widgets" project whose name would also satisfy a substring/regex name match.
  const acmeWidgetCard = page.locator(`a[href="/projects/${projectId("acme-widget")}"]`)

  await page.goto("/projects")
  await expect(acmeWidgetCard).toBeVisible()

  const otherToken = await mintSessionToken(E2E_OTHER_USER_ID)
  await context.addCookies([
    {
      name: "session",
      value: otherToken,
      domain: "localhost",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ])
  await page.goto("/projects")
  await expect(acmeWidgetCard).toHaveCount(0)
})
