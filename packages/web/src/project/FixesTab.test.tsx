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

// moves to RunsTab.test.tsx
// const RUNNING = { ...RUN, id: "r-2", status: "running", finishedAt: null }
//
// /**
//  * A server with one run that is going until `polls` status checks have answered: the list
//  * reports it running until then, and the learning appears once it is done.
//  */
// const stubRun = (polls: number) => {
//   const posts: unknown[] = []
//   let checks = 0
//   const done = () => checks >= polls
//   vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
//     const url = input instanceof Request ? input.url : String(input)
//     const method = input instanceof Request ? input.method : (init?.method ?? "GET")
//     const reply = (status: number, body: unknown) =>
//       Promise.resolve(new Response(JSON.stringify(body), { status }))
//     if (url.includes("/api/learnings/runs/r-2")) {
//       checks += 1
//       return reply(200, { run: done() ? { ...RUNNING, status: "done" } : RUNNING })
//     }
//     if (url.includes("/api/learnings/runs") && method === "POST") {
//       const body = input instanceof Request ? input.clone().text() : Promise.resolve(init?.body)
//       return Promise.resolve(body).then((text) => {
//         posts.push(JSON.parse(String(text)))
//         return new Response(JSON.stringify({ runId: "r-2" }), { status: 202 })
//       })
//     }
//     if (url.includes("/api/learnings"))
//       return reply(200, {
//         learnings: done() ? [LEARNING] : [],
//         latestRun: posts.length === 0 ? null : done() ? { ...RUNNING, status: "done" } : RUNNING,
//         canEdit: true,
//       })
//     if (url.includes("/api/projects")) return reply(200, projectsBody)
//     return reply(401, { error: "unauthorized" })
//   })
//   return posts
// }
//
// test("LR6: Run now starts a run for the chosen project, waits for it, and shows its learnings", async () => {
//   const posts = stubRun(2)
//   renderPage()
//   const user = userEvent.setup()
//   await screen.findByText("No learnings here yet")
//   // Only the poll's interval is faked, so clicks and fetches still run on real time.
//   vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
//
//   await user.click(screen.getByRole("button", { name: "Run now" }))
//
//   expect(posts).toEqual([{ project: "p-1" }])
//   expect(await screen.findByText(/Running…/)).toBeInTheDocument()
//   expect(screen.getByRole("button", { name: "Run now" })).toBeDisabled()
//
//   // First check still running, second done: the list reloads with the new learning.
//   await act(async () => {
//     await vi.advanceTimersByTimeAsync(RUN_POLL_MS)
//   })
//   expect(screen.queryByText(LEARNING.title)).not.toBeInTheDocument()
//   await act(async () => {
//     await vi.advanceTimersByTimeAsync(RUN_POLL_MS)
//   })
//   vi.useRealTimers()
//   expect(await screen.findByText(LEARNING.title)).toBeInTheDocument()
//   expect(screen.getByRole("button", { name: "Run now" })).toBeEnabled()
// })
//
// test("LR7: a run already going when the page opens shows as running", async () => {
//   stubFetch([
//     { match: "/api/learnings/runs/r-2", status: 200, body: { run: RUNNING } },
//     {
//       match: "/api/learnings",
//       status: 200,
//       body: { learnings: [], latestRun: RUNNING, canEdit: true },
//     },
//   ])
//
//   renderPage()
//
//   expect(await screen.findByText(/Running…/)).toBeInTheDocument()
//   expect(screen.getByRole("button", { name: "Run now" })).toBeDisabled()
// })
//
// test("SC47: the fixes page waits on a queued run, and reloads once it is done", async () => {
//   const WAITING = { ...RUNNING, status: "waiting" }
//   let checks = 0
//   vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
//     const url = input instanceof Request ? input.url : String(input)
//     const reply = (status: number, body: unknown) =>
//       Promise.resolve(new Response(JSON.stringify(body), { status }))
//     const finished = checks >= 2
//     if (url.includes("/api/learnings/runs/r-2")) {
//       checks += 1
//       // Still queued at the first check, done at the second.
//       return reply(200, { run: checks >= 2 ? { ...RUNNING, status: "done" } : WAITING })
//     }
//     if (url.includes("/api/learnings"))
//       return reply(200, {
//         learnings: finished ? [LEARNING] : [],
//         latestRun: finished ? { ...RUNNING, status: "done" } : WAITING,
//         canEdit: true,
//       })
//     if (url.includes("/api/projects")) return reply(200, projectsBody)
//     return reply(401, { error: "unauthorized" })
//   })
//   // The poll starts as the page loads, so its interval is faked from the start.
//   vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
//   renderPage()
//
//   expect(await screen.findByText(/Running…/)).toBeInTheDocument()
//   expect(screen.getByRole("button", { name: "Run now" })).toBeDisabled()
//
//   await act(async () => {
//     await vi.advanceTimersByTimeAsync(RUN_POLL_MS)
//   })
//   expect(screen.getByRole("button", { name: "Run now" })).toBeDisabled()
//   await act(async () => {
//     await vi.advanceTimersByTimeAsync(RUN_POLL_MS)
//   })
//   vi.useRealTimers()
//   expect(await screen.findByText(LEARNING.title)).toBeInTheDocument()
//   expect(screen.getByRole("button", { name: "Run now" })).toBeEnabled()
// })
//
// test("LR8: a refused run says why in plain words", async () => {
//   stubFetch([
//     { match: "/api/learnings/runs", status: 400, body: { error: "noHarnessPath" } },
//     {
//       match: "/api/learnings",
//       status: 200,
//       body: { learnings: [], latestRun: null, canEdit: true },
//     },
//   ])
//   renderPage()
//   const user = userEvent.setup()
//   await screen.findByText("No learnings here yet")
//
//   await user.click(screen.getByRole("button", { name: "Run now" }))
//
//   expect(await screen.findByText(/LEARNINGS_HARNESS_PATH/)).toBeInTheDocument()
//   expect(screen.getByRole("button", { name: "Run now" })).toBeEnabled()
// })

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
const skippedAt = "2026-10-29T09:00:00.000Z"

test("SC32: Skip on a card takes the fix out of the list at once, without opening its page", async () => {
  const urls = stubFetch([
    {
      match: "/api/learnings/l-1/skip",
      method: "POST",
      status: 200,
      body: { learning: { ...LEARNING, skippedAt } },
    },
    {
      match: "/api/learnings",
      status: 200,
      body: { learnings: [LEARNING, SECOND], latestRun: RUN, canEdit: true },
    },
  ])
  renderPage()
  const user = userEvent.setup()

  const card = (await screen.findByText(LEARNING.title)).closest("article") as HTMLElement
  await user.click(within(card).getByRole("button", { name: "Skip" }))

  await waitFor(() => expect(screen.queryByText(LEARNING.title)).toBeNull())
  expect(screen.getByText(SECOND.title)).toBeInTheDocument()
  expect(screen.getByText("Showing 1 of 1")).toBeInTheDocument()
  expect(
    urls.some((url) => url.startsWith("POST") && url.includes("/api/learnings/l-1/skip")),
  ).toBe(true)
  expect(screen.getByTestId("location")).toHaveTextContent(/^\/projects\/p-1\/fixes$/)
})

test("SC33: Show Skipped lists only skipped fixes with Unskip, and Unskip takes one out", async () => {
  stubFetch([
    {
      match: "/api/learnings/l-1/skip",
      method: "DELETE",
      status: 200,
      body: { learning: { ...LEARNING, skippedAt: null } },
    },
    {
      match: "/api/learnings",
      status: 200,
      body: { learnings: [{ ...LEARNING, skippedAt }, SECOND], latestRun: RUN, canEdit: true },
    },
  ])
  renderPage("/projects/p-1/fixes?show=skipped")
  const user = userEvent.setup()

  const card = (await screen.findByText(LEARNING.title)).closest("article") as HTMLElement
  expect(screen.queryByText(SECOND.title)).toBeNull()
  await user.click(within(card).getByRole("button", { name: "Unskip" }))

  expect(await screen.findByText("No skipped fixes")).toBeInTheDocument()
  expect(screen.queryByText(LEARNING.title)).toBeNull()
})

test("a project whose every fix is skipped says so and points to Show Skipped, not 'No learnings here yet'", async () => {
  stubFetch([
    {
      match: "/api/learnings",
      status: 200,
      body: { learnings: [{ ...LEARNING, skippedAt }], latestRun: RUN, canEdit: true },
    },
  ])
  renderPage()

  expect(await screen.findByText("Every fix here is skipped")).toBeInTheDocument()
  expect(screen.getByText(/Show "Skipped"/)).toBeInTheDocument()
  expect(screen.queryByText("No learnings here yet")).toBeNull()
})

test("SC34: a viewer sees no Skip or Unskip button on the list", async () => {
  stubFetch([
    {
      match: "/api/learnings",
      status: 200,
      body: { learnings: [LEARNING], latestRun: RUN, canEdit: false },
    },
  ])
  renderPage()

  await screen.findByText(LEARNING.title)
  expect(screen.queryByRole("button", { name: /^(Skip|Unskip)$/ })).toBeNull()
})

test("SC35: a refused skip says why in words, and the fix stays", async () => {
  stubFetch([
    {
      match: "/api/learnings/l-1/skip",
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
    await screen.findByText("You need edit rights on this project to skip a fix."),
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
