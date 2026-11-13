import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { TestRouter } from "../tests/test-router.js"
import { FixesTab } from "./FixesTab.js"

const LEARNING = {
  id: "l-1",
  title: "Helpers report while their test run is still going",
  cause: "The implement skill never tells helpers to wait for a test run to exit.",
  problem: "Coder agents end their turn saying they are waiting on jest.",
  priority: "high",
  priorityReason: "it keeps happening, and two sessions shipped untested work",
  fixType: "skill",
  fix: "In skills/implement/SKILL.md, wait for the test command to exit before reporting.",
  impact: null,
  impactReason: null,
  howItHelps: null,
  fixSummary: null,
  story: null,
  decision: "open",
  decidedAt: null,
  rejectReason: null,
  skipCount: 0,
  sessionsAtSkip: null,
  returnsAtSessions: null,
  skippedAt: null,
  updatedByRunId: "r-1",
  createdAt: "2026-10-20T10:00:00.000Z",
  updatedAt: "2026-10-20T10:00:00.000Z",
  problemCount: 9,
  sessionCount: 6,
  firstSeenAt: null,
  lastSeenAt: null,
  sessionsLast7Days: 0,
}

const RUN = {
  id: "r-1",
  status: "succeeded",
  harnessRef: "abc123",
  error: null,
  startedAt: "2026-10-20T10:00:00.000Z",
  finishedAt: "2026-10-20T10:08:00.000Z",
}

/** Answers by URL substring (and method, when a route names one), first match wins, and records every "METHOD url" asked for. */
const stubFetch = (
  routes: ReadonlyArray<{ match: string; status: number; body: unknown; method?: string }>,
) => {
  const urls: string[] = []
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    const method = input instanceof Request ? input.method : (init?.method ?? "GET")
    urls.push(`${method} ${url}`)
    const route = routes.find(
      (r) => url.includes(r.match) && (r.method === undefined || r.method === method),
    )
    return Promise.resolve(
      route === undefined
        ? new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })
        : new Response(JSON.stringify(route.body), { status: route.status }),
    )
  })
  return urls
}

const renderPage = (path = "/projects/p-1/fixes") =>
  render(
    <TestRouter initialEntries={[path]}>
      <Routes>
        <Route path="/projects/:id/*" element={<FixesTab projectId="p-1" />} />
      </Routes>
    </TestRouter>,
  )

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

test("LR1: shows the project's learnings with priority, counts and fix", async () => {
  const urls = stubFetch([
    {
      match: "/api/learnings",
      status: 200,
      body: { learnings: [LEARNING], latestRun: RUN, canEdit: true },
    },
  ])

  renderPage()

  const card = (await screen.findByText(LEARNING.title)).closest("article") as HTMLElement
  expect(within(card).getByText("high")).toBeInTheDocument()
  expect(within(card).getByText(/9 problems in 6 sessions/)).toBeInTheDocument()
  expect(within(card).getByText(/wait for the test command to exit/)).toBeInTheDocument()
  expect(urls.some((url) => url.includes("/api/learnings?project=p-1"))).toBe(true)
})

test("SC23: a card's link opens its fix page carrying the list's filters, and Show problems is gone", async () => {
  stubFetch([
    {
      match: "/api/learnings",
      status: 200,
      body: { learnings: [LEARNING], latestRun: RUN, canEdit: true },
    },
  ])

  renderPage("/projects/p-1/fixes?show=10")

  const card = (await screen.findByText(LEARNING.title)).closest("article") as HTMLElement
  expect(within(card).getByRole("link", { name: LEARNING.title })).toHaveAttribute(
    "href",
    "/learnings/l-1?show=10",
  )
  expect(within(card).queryByRole("button", { name: "Show problems" })).toBeNull()
})

test("SC401: a card shows only its title row, what goes wrong, why it matters and the plain fix", async () => {
  const written = {
    ...LEARNING,
    impact: "person_stepped_in",
    impactReason: "the person had to chase the coder three times",
    howItHelps: "Saves about 10 minutes a run of chasing helpers.",
    fixSummary: "Make helpers wait for their tests to finish before they report.",
  }
  stubFetch([
    {
      match: "/api/learnings",
      status: 200,
      body: { learnings: [written], latestRun: RUN, canEdit: true },
    },
  ])

  renderPage()

  const card = (await screen.findByText(LEARNING.title)).closest("article") as HTMLElement
  expect(within(card).getByText("high")).toBeInTheDocument()
  expect(within(card).getByText(/9 problems in 6 sessions/)).toBeInTheDocument()
  expect(within(card).getByText(LEARNING.problem)).toBeInTheDocument()
  expect(card).toHaveTextContent("Why it matters: The person had to chase the coder three times")
  expect(card).toHaveTextContent(
    "Fix: Make helpers wait for their tests to finish before they report.",
  )
  for (const gone of [/How it helps/, /Why high/, /Impact:/, /\(Skill\)/, /Saves about 10 minutes/])
    expect(card.textContent).not.toMatch(gone)
})

test("SC402: an older fix's card shows its own problem text and exact fix, and no Why it matters line", async () => {
  stubFetch([
    {
      match: "/api/learnings",
      status: 200,
      body: { learnings: [LEARNING], latestRun: RUN, canEdit: true },
    },
  ])

  renderPage()

  const card = (await screen.findByText(LEARNING.title)).closest("article") as HTMLElement
  expect(within(card).getByText(LEARNING.problem)).toBeInTheDocument()
  expect(card).toHaveTextContent(`Fix: ${LEARNING.fix}`)
  expect(card.textContent).not.toMatch(/Why it matters/)
})

test("LR4: a project with no learnings says when they appear", async () => {
  stubFetch([
    {
      match: "/api/learnings",
      status: 200,
      body: { learnings: [], latestRun: null, canEdit: true },
    },
  ])

  renderPage()

  expect(await screen.findByText("No learnings here yet")).toBeInTheDocument()
})

test("LR5: a failed load surfaces the error, not a silent blank", async () => {
  stubFetch([{ match: "/api/learnings", status: 500, body: { error: "internal" } }])

  renderPage()

  expect(await screen.findByText("Retrieval failed")).toBeInTheDocument()
})

/** Twelve learnings, numbered in the order the server ranks them. */
const MANY = Array.from({ length: 12 }, (_, index) => ({
  ...LEARNING,
  id: `l-${index + 1}`,
  title: `Learning number ${index + 1}`,
}))

test("LR9: shows the top 5 by default, and says how many there are", async () => {
  stubFetch([
    {
      match: "/api/learnings",
      status: 200,
      body: { learnings: MANY, latestRun: RUN, canEdit: true },
    },
  ])

  renderPage()

  expect(await screen.findByText("Learning number 1")).toBeInTheDocument()
  expect(screen.getByText("Learning number 5")).toBeInTheDocument()
  expect(screen.queryByText("Learning number 6")).not.toBeInTheDocument()
  expect(screen.getByText("Showing 5 of 12")).toBeInTheDocument()
})

test("LR10: the Show filter picks how many, and the choice is kept in the URL", async () => {
  stubFetch([
    {
      match: "/api/learnings",
      status: 200,
      body: { learnings: MANY, latestRun: RUN, canEdit: true },
    },
  ])
  renderPage("/projects/p-1/fixes?show=10")
  const user = userEvent.setup()

  expect(await screen.findByText("Learning number 10")).toBeInTheDocument()
  expect(screen.queryByText("Learning number 11")).not.toBeInTheDocument()

  await user.selectOptions(screen.getByRole("combobox", { name: "Show" }), "all")
  expect(screen.getByText("Learning number 12")).toBeInTheDocument()
  expect(screen.getByText("Showing 12 of 12")).toBeInTheDocument()
})

const SECOND = { ...LEARNING, id: "l-2", title: "Agents edit the lockfile by hand" }
const decidedAt = "2026-10-29T09:00:00.000Z"
const OPEN = { ...LEARNING, id: "l-o", title: "An open fix" }
const ACCEPTED = {
  ...LEARNING,
  id: "l-a",
  title: "An accepted fix",
  decision: "accepted",
  decidedAt,
}
const SKIPPED = {
  ...LEARNING,
  id: "l-s",
  title: "A skipped fix",
  decision: "skipped",
  decidedAt,
  skippedAt: decidedAt,
  skipCount: 1,
  sessionsAtSkip: 4,
  returnsAtSessions: 14,
}
const REJECTED = {
  ...LEARNING,
  id: "l-r",
  title: "A rejected fix",
  decision: "rejected",
  decidedAt,
  skippedAt: decidedAt,
  rejectReason: "not ours",
}
const FOUR = [OPEN, ACCEPTED, SKIPPED, REJECTED]
const shownTitles = () =>
  screen.queryAllByRole("article").map((card) => within(card).getAllByRole("link")[0]?.textContent)

test("SC810: the Status filter lists each decision, Open showing accepted ones marked", async () => {
  stubFetch([
    {
      match: "/api/learnings",
      status: 200,
      body: { learnings: FOUR, latestRun: RUN, canEdit: true },
    },
  ])
  renderPage()
  const user = userEvent.setup()

  await screen.findByText(OPEN.title)
  expect(shownTitles()).toEqual([OPEN.title, ACCEPTED.title])
  const accepted = screen.getByText(ACCEPTED.title).closest("article") as HTMLElement
  expect(within(accepted).getByText("accepted")).toBeInTheDocument()
  const open = screen.getByText(OPEN.title).closest("article") as HTMLElement
  expect(within(open).queryByText("accepted")).toBeNull()

  const status = screen.getByRole("combobox", { name: "Status" })
  await user.selectOptions(status, "accepted")
  expect(shownTitles()).toEqual([ACCEPTED.title])
  expect(screen.getByTestId("location")).toHaveTextContent("status=accepted")
  await user.selectOptions(status, "skipped")
  expect(shownTitles()).toEqual([SKIPPED.title])
  await user.selectOptions(status, "rejected")
  expect(shownTitles()).toEqual([REJECTED.title])
  const rejected = screen.getByText(REJECTED.title).closest("article") as HTMLElement
  expect(within(rejected).getByText(/not ours/)).toBeInTheDocument()
  await user.selectOptions(status, "all")
  expect(shownTitles()).toEqual(FOUR.map((row) => row.title))
  // The Show count still limits whichever status is chosen.
  expect(screen.getByRole("combobox", { name: "Show" })).toHaveValue("5")
  expect(
    within(screen.getByRole("combobox", { name: "Show" })).queryByRole("option", {
      name: "Skipped",
    }),
  ).toBeNull()
})

test("an old ?show=skipped link lists the skipped fixes under the default Show count", async () => {
  stubFetch([
    {
      match: "/api/learnings",
      status: 200,
      body: { learnings: FOUR, latestRun: RUN, canEdit: true },
    },
  ])
  renderPage("/projects/p-1/fixes?show=skipped")

  await screen.findByText(SKIPPED.title)
  expect(shownTitles()).toEqual([SKIPPED.title])
  expect(screen.getByRole("combobox", { name: "Status" })).toHaveValue("skipped")
  expect(screen.getByRole("combobox", { name: "Show" })).toHaveValue("5")
})

test("from an old ?show=skipped link, choosing Open lists open fixes, and changing Show then keeps Status as chosen", async () => {
  stubFetch([
    {
      match: "/api/learnings",
      status: 200,
      body: { learnings: FOUR, latestRun: RUN, canEdit: true },
    },
  ])
  renderPage("/projects/p-1/fixes?show=skipped&type=skill")
  const user = userEvent.setup()

  await screen.findByText(SKIPPED.title)
  expect(screen.getByTestId("location")).toHaveTextContent(
    /^\/projects\/p-1\/fixes\?type=skill&status=skipped$/,
  )

  await user.selectOptions(screen.getByRole("combobox", { name: "Status" }), "open")
  expect(shownTitles()).toEqual([OPEN.title, ACCEPTED.title])
  expect(screen.getByTestId("location")).toHaveTextContent(/^\/projects\/p-1\/fixes\?type=skill$/)

  await user.selectOptions(screen.getByRole("combobox", { name: "Status" }), "skipped")
  await user.selectOptions(screen.getByRole("combobox", { name: "Show" }), "10")
  expect(shownTitles()).toEqual([SKIPPED.title])
  expect(screen.getByRole("combobox", { name: "Status" })).toHaveValue("skipped")
})

test("SC825: a skipped card says how many more sessions until it returns", async () => {
  stubFetch([
    {
      match: "/api/learnings",
      status: 200,
      body: {
        learnings: [{ ...SKIPPED, sessionCount: 7 }, ACCEPTED],
        latestRun: RUN,
        canEdit: true,
      },
    },
  ])
  renderPage("/projects/p-1/fixes?status=all")

  const skipped = (await screen.findByText(SKIPPED.title)).closest("article") as HTMLElement
  expect(within(skipped).getByText(/^Skipped/)).toHaveTextContent(/· back after 7 more sessions$/)
  const accepted = screen.getByText(ACCEPTED.title).closest("article") as HTMLElement
  expect(within(accepted).getByText(/^Accepted/)).not.toHaveTextContent(/back after/)
})

test("SC811: Reject asks for a reason before it sends anything", async () => {
  const urls = stubFetch([
    {
      match: "/api/learnings/l-1/decision",
      method: "POST",
      status: 200,
      body: {
        learning: { ...LEARNING, decision: "rejected", decidedAt, rejectReason: "not ours" },
      },
    },
    {
      match: "/api/learnings",
      status: 200,
      body: { learnings: [LEARNING, SECOND], latestRun: RUN, canEdit: true },
    },
  ])
  const posted: unknown[] = []
  const fetchSpy = vi.mocked(globalThis.fetch)
  const original = fetchSpy.getMockImplementation()
  fetchSpy.mockImplementation(async (input, init) => {
    if (input instanceof Request && input.method === "POST") posted.push(await input.clone().json())
    else if (init?.method === "POST") posted.push(JSON.parse(String(init.body)))
    return (original as typeof fetch)(input, init)
  })
  renderPage()
  const user = userEvent.setup()

  const card = (await screen.findByText(LEARNING.title)).closest("article") as HTMLElement
  await user.click(within(card).getByRole("button", { name: "Reject" }))
  const reasons = within(card).getByRole("group", { name: "Why reject it?" })
  expect(
    within(reasons)
      .getAllByRole("button")
      .map((button) => button.textContent),
  ).toEqual(["Not a real problem", "The person's own fault", "One-off", "Already fixed", "Cancel"])
  await user.click(within(reasons).getByRole("button", { name: "Cancel" }))
  expect(within(card).queryByRole("group", { name: "Why reject it?" })).toBeNull()
  expect(urls.some((url) => url.startsWith("POST"))).toBe(false)

  await user.click(within(card).getByRole("button", { name: "Reject" }))
  await user.click(within(card).getByRole("button", { name: "Not a real problem" }))

  await waitFor(() => expect(screen.queryByText(LEARNING.title)).toBeNull())
  expect(posted).toEqual([{ decision: "rejected", reason: "Not a real problem" }])
  expect(screen.getByText(SECOND.title)).toBeInTheDocument()
  expect(screen.getByTestId("location")).toHaveTextContent(/^\/projects\/p-1\/fixes$/)
})

test("a project whose every fix is skipped or rejected says so and points to Status All, not 'No learnings here yet'", async () => {
  stubFetch([
    {
      match: "/api/learnings",
      status: 200,
      body: { learnings: [SKIPPED, REJECTED], latestRun: RUN, canEdit: true },
    },
  ])
  renderPage()

  expect(await screen.findByText("Every fix here is skipped or rejected")).toBeInTheDocument()
  expect(screen.getByText(/Status "All"/)).toBeInTheDocument()
  expect(screen.queryByText("No learnings here yet")).toBeNull()
})

test("SC812: a viewer sees decisions but no Accept, Skip or Reject button on the list", async () => {
  stubFetch([
    {
      match: "/api/learnings",
      status: 200,
      body: { learnings: [OPEN, ACCEPTED], latestRun: RUN, canEdit: false },
    },
  ])
  renderPage()

  await screen.findByText(OPEN.title)
  const accepted = screen.getByText(ACCEPTED.title).closest("article") as HTMLElement
  expect(within(accepted).getByText(/^Accepted/)).toBeInTheDocument()
  expect(screen.queryByRole("button", { name: /^(Accept|Skip|Reject)$/ })).toBeNull()
})

test("SC35: a refused decision says why in words, and the fix stays", async () => {
  stubFetch([
    {
      match: "/api/learnings/l-1/decision",
      method: "POST",
      status: 403,
      body: { error: "notEditable" },
    },
    {
      match: "/api/learnings",
      status: 200,
      body: { learnings: [LEARNING], latestRun: RUN, canEdit: true },
    },
  ])
  renderPage()
  const user = userEvent.setup()

  const card = (await screen.findByText(LEARNING.title)).closest("article") as HTMLElement
  await user.click(within(card).getByRole("button", { name: "Skip" }))

  expect(
    await screen.findByText("You need edit rights on this project to decide on a fix."),
  ).toBeInTheDocument()
  expect(screen.getByText(LEARNING.title)).toBeInTheDocument()
})

test("the card shows the fix in plain words, not the exact text, when it has one", async () => {
  const plain = { ...LEARNING, fixSummary: "Make helpers wait for their tests to finish." }
  stubFetch([
    {
      match: "/api/learnings",
      status: 200,
      body: { learnings: [plain], latestRun: RUN, canEdit: true },
    },
  ])

  renderPage()

  const card = (await screen.findByText(LEARNING.title)).closest("article") as HTMLElement
  expect(
    within(card).getByText(/Make helpers wait for their tests to finish\./),
  ).toBeInTheDocument()
  expect(within(card).queryByText(LEARNING.fix)).toBeNull()
})

test("the page has no How this page works box", async () => {
  stubFetch([
    {
      match: "/api/learnings",
      status: 200,
      body: { learnings: [LEARNING], latestRun: RUN, canEdit: true },
    },
  ])

  renderPage()

  await screen.findByText(LEARNING.title)
  expect(screen.queryByText(/How this page works/i)).toBeNull()
})

const lastLearningsUrl = (urls: ReadonlyArray<string>) =>
  urls.filter((url) => url.includes("/api/learnings?")).at(-1) ?? ""

test("SC717: choosing a type and dates asks the server for them and keeps them in the URL", async () => {
  const urls = stubFetch([
    {
      match: "/api/learnings",
      status: 200,
      body: { learnings: [LEARNING], latestRun: RUN, canEdit: true },
    },
  ])
  renderPage()
  const user = userEvent.setup()
  await screen.findByText(LEARNING.title)

  await user.selectOptions(screen.getByRole("combobox", { name: "Type" }), "skill")
  fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-11-01" } })
  fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-11-12" } })

  await waitFor(() =>
    expect(lastLearningsUrl(urls)).toContain(
      "/api/learnings?project=p-1&type=skill&from=2026-11-01T00%3A00%3A00.000Z&to=2026-11-13T00%3A00%3A00.000Z",
    ),
  )
  expect(screen.getByTestId("location")).toHaveTextContent(
    "/projects/p-1/fixes?type=skill&from=2026-11-01&to=2026-11-12",
  )

  await user.selectOptions(screen.getByRole("combobox", { name: "Type" }), "")
  await waitFor(() => expect(lastLearningsUrl(urls)).not.toContain("type="))
  expect(screen.getByTestId("location")).not.toHaveTextContent("type=")
})

test("SC718: a reload with filters in the URL shows them and asks for them, and no To is sent when none is set", async () => {
  const urls = stubFetch([
    {
      match: "/api/learnings",
      status: 200,
      body: { learnings: [LEARNING], latestRun: RUN, canEdit: true },
    },
  ])
  renderPage("/projects/p-1/fixes?type=code&from=2026-11-01")

  await screen.findByText(LEARNING.title)
  expect(screen.getByRole("combobox", { name: "Type" })).toHaveValue("code")
  expect(screen.getByLabelText("From")).toHaveValue("2026-11-01")
  expect(screen.getByLabelText("To")).toHaveValue("")
  const first = urls.find((url) => url.includes("/api/learnings?")) ?? ""
  expect(first).toContain("type=code")
  expect(first).toContain("from=2026-11-01T00%3A00%3A00.000Z")
  expect(first).not.toContain("to=")
})

test("SC719: a card says when its fix was first and last seen and how many sessions saw it this week", async () => {
  const seen = {
    ...LEARNING,
    firstSeenAt: "2026-11-03T10:00:00.000Z",
    lastSeenAt: "2026-11-11T10:00:00.000Z",
    sessionsLast7Days: 4,
  }
  stubFetch([
    {
      match: "/api/learnings",
      status: 200,
      body: { learnings: [seen, SECOND], latestRun: RUN, canEdit: true },
    },
  ])
  renderPage()

  const card = (await screen.findByText(LEARNING.title)).closest("article") as HTMLElement
  expect(
    within(card).getByText(
      "first seen Nov 3, 2026 · last seen Nov 11, 2026 · seen in 4 sessions in the last 7 days",
    ),
  ).toBeInTheDocument()
  const unseen = screen.getByText(SECOND.title).closest("article") as HTMLElement
  expect(unseen.textContent).not.toMatch(/first seen/)
})

test("SC720: filters that match nothing say so, not that the project has no fixes yet", async () => {
  stubFetch([
    {
      match: "/api/learnings",
      status: 200,
      body: { learnings: [], latestRun: RUN, canEdit: true },
    },
  ])
  renderPage("/projects/p-1/fixes?type=human")

  expect(await screen.findByText("No fixes match these filters")).toBeInTheDocument()
  expect(screen.queryByText("No learnings here yet")).toBeNull()
})
