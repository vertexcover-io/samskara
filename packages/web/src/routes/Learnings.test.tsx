import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { TestRouter } from "../tests/test-router.js"
import { Learnings, RUN_POLL_MS } from "./Learnings.js"

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
  skippedAt: null,
  updatedByRunId: "r-1",
  createdAt: "2026-10-20T10:00:00.000Z",
  updatedAt: "2026-10-20T10:00:00.000Z",
  problemCount: 9,
  sessionCount: 6,
}

const RUN = {
  id: "r-1",
  status: "succeeded",
  harnessRef: "abc123",
  error: null,
  startedAt: "2026-10-20T10:00:00.000Z",
  finishedAt: "2026-10-20T10:08:00.000Z",
}

const project = (id: string, name: string) => ({
  id,
  name,
  slug: name.toLowerCase(),
  owner: { type: "user", slug: "dev" },
  sessionCount: 3,
  lastActiveAt: "2026-10-20T12:00:00.000Z",
  repo: null,
})

const projectsBody = { projects: [project("p-1", "Samskara"), project("p-2", "Yok")] }

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

const renderPage = (path = "/learnings") =>
  render(
    <TestRouter initialEntries={[path]}>
      <Learnings />
    </TestRouter>,
  )

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

test("LR1: shows the first project's learnings with priority, counts, fix and the last run", async () => {
  const urls = stubFetch([
    {
      match: "/api/learnings",
      status: 200,
      body: { learnings: [LEARNING], latestRun: RUN, canEdit: true },
    },
    { match: "/api/projects", status: 200, body: projectsBody },
  ])

  renderPage()

  const card = (await screen.findByText(LEARNING.title)).closest("article") as HTMLElement
  expect(within(card).getByText("high")).toBeInTheDocument()
  expect(within(card).getByText(/9 problems in 6 sessions/)).toBeInTheDocument()
  expect(within(card).getByText(/wait for the test command to exit/)).toBeInTheDocument()
  expect(within(card).getByText(/Fix \(Skill\)/)).toBeInTheDocument()
  expect(screen.getByText(/Last run .* succeeded/)).toBeInTheDocument()
  expect(screen.getByText(/samskara learn --project/)).toBeInTheDocument()
  expect(urls.some((url) => url.includes("/api/learnings?project=p-1"))).toBe(true)
})

test("SC23: a card's link opens its fix page carrying the list's filters, and Show problems is gone", async () => {
  stubFetch([
    {
      match: "/api/learnings",
      status: 200,
      body: { learnings: [LEARNING], latestRun: RUN, canEdit: true },
    },
    { match: "/api/projects", status: 200, body: projectsBody },
  ])

  renderPage("/learnings?project=p-1&show=10")

  const card = (await screen.findByText(LEARNING.title)).closest("article") as HTMLElement
  expect(within(card).getByRole("link", { name: LEARNING.title })).toHaveAttribute(
    "href",
    "/learnings/l-1?project=p-1&show=10",
  )
  expect(within(card).queryByRole("button", { name: "Show problems" })).toBeNull()
})

test("SC14: the card shows the impact in words with its sentence, and how the fix helps", async () => {
  const withImpact = {
    ...LEARNING,
    impact: "person_stepped_in",
    impactReason: "the person had to chase the coder three times",
    howItHelps: "Saves about 10 minutes a run of chasing helpers.",
  }
  stubFetch([
    {
      match: "/api/learnings",
      status: 200,
      body: { learnings: [withImpact], latestRun: RUN, canEdit: true },
    },
    { match: "/api/projects", status: 200, body: projectsBody },
  ])

  renderPage()

  const card = (await screen.findByText(LEARNING.title)).closest("article") as HTMLElement
  expect(within(card).getByText(/Person had to step in/)).toBeInTheDocument()
  expect(
    within(card).getByText(/the person had to chase the coder three times/),
  ).toBeInTheDocument()
  expect(within(card).getByText(/How it helps:/)).toBeInTheDocument()
  expect(within(card).getByText(/Saves about 10 minutes a run/)).toBeInTheDocument()
})

test("SC15: an older learning's card shows no impact or how-it-helps line, and the rest still shows", async () => {
  stubFetch([
    {
      match: "/api/learnings",
      status: 200,
      body: { learnings: [LEARNING], latestRun: RUN, canEdit: true },
    },
    { match: "/api/projects", status: 200, body: projectsBody },
  ])

  renderPage()

  const card = (await screen.findByText(LEARNING.title)).closest("article") as HTMLElement
  expect(within(card).queryByText(/Impact:/)).toBeNull()
  expect(within(card).queryByText(/How it helps:/)).toBeNull()
  expect(within(card).getByText(LEARNING.problem)).toBeInTheDocument()
  expect(within(card).getByText(/wait for the test command to exit/)).toBeInTheDocument()
})

test("LR3: choosing another project loads that project's learnings", async () => {
  const urls = stubFetch([
    {
      match: "/api/learnings",
      status: 200,
      body: { learnings: [LEARNING], latestRun: RUN, canEdit: true },
    },
    { match: "/api/projects", status: 200, body: projectsBody },
  ])

  renderPage()
  const user = userEvent.setup()
  await screen.findByText(LEARNING.title)
  await user.selectOptions(screen.getByRole("combobox", { name: "Project" }), "p-2")

  await waitFor(() => {
    expect(urls.some((url) => url.includes("/api/learnings?project=p-2"))).toBe(true)
  })
})

test("LR4: a project with no learnings says when they appear", async () => {
  stubFetch([
    {
      match: "/api/learnings",
      status: 200,
      body: { learnings: [], latestRun: null, canEdit: true },
    },
    { match: "/api/projects", status: 200, body: projectsBody },
  ])

  renderPage()

  expect(await screen.findByText("No learnings here yet")).toBeInTheDocument()
  expect(screen.getByText("No learning run yet")).toBeInTheDocument()
})

test("LR5: a failed load surfaces the error, not a silent blank", async () => {
  stubFetch([
    { match: "/api/learnings", status: 500, body: { error: "internal" } },
    { match: "/api/projects", status: 200, body: projectsBody },
  ])

  renderPage()

  expect(await screen.findByText("Retrieval failed")).toBeInTheDocument()
})

const RUNNING = { ...RUN, id: "r-2", status: "running", finishedAt: null }

/**
 * A server with one run that is going until `polls` status checks have answered: the list
 * reports it running until then, and the learning appears once it is done.
 */
const stubRun = (polls: number) => {
  const posts: unknown[] = []
  let checks = 0
  const done = () => checks >= polls
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    const method = input instanceof Request ? input.method : (init?.method ?? "GET")
    const reply = (status: number, body: unknown) =>
      Promise.resolve(new Response(JSON.stringify(body), { status }))
    if (url.includes("/api/learnings/runs/r-2")) {
      checks += 1
      return reply(200, { run: done() ? { ...RUNNING, status: "done" } : RUNNING })
    }
    if (url.includes("/api/learnings/runs") && method === "POST") {
      const body = input instanceof Request ? input.clone().text() : Promise.resolve(init?.body)
      return Promise.resolve(body).then((text) => {
        posts.push(JSON.parse(String(text)))
        return new Response(JSON.stringify({ runId: "r-2" }), { status: 202 })
      })
    }
    if (url.includes("/api/learnings"))
      return reply(200, {
        learnings: done() ? [LEARNING] : [],
        latestRun: posts.length === 0 ? null : done() ? { ...RUNNING, status: "done" } : RUNNING,
        canEdit: true,
      })
    if (url.includes("/api/projects")) return reply(200, projectsBody)
    return reply(401, { error: "unauthorized" })
  })
  return posts
}

test("LR6: Run now starts a run for the chosen project, waits for it, and shows its learnings", async () => {
  const posts = stubRun(2)
  renderPage()
  const user = userEvent.setup()
  await screen.findByText("No learnings here yet")
  // Only the poll's interval is faked, so clicks and fetches still run on real time.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })

  await user.click(screen.getByRole("button", { name: "Run now" }))

  expect(posts).toEqual([{ project: "p-1" }])
  expect(await screen.findByText(/Running…/)).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Run now" })).toBeDisabled()

  // First check still running, second done: the list reloads with the new learning.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(RUN_POLL_MS)
  })
  expect(screen.queryByText(LEARNING.title)).not.toBeInTheDocument()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(RUN_POLL_MS)
  })
  vi.useRealTimers()
  expect(await screen.findByText(LEARNING.title)).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Run now" })).toBeEnabled()
})

test("LR7: a run already going when the page opens shows as running", async () => {
  stubFetch([
    { match: "/api/learnings/runs/r-2", status: 200, body: { run: RUNNING } },
    {
      match: "/api/learnings",
      status: 200,
      body: { learnings: [], latestRun: RUNNING, canEdit: true },
    },
    { match: "/api/projects", status: 200, body: projectsBody },
  ])

  renderPage()

  expect(await screen.findByText(/Running…/)).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Run now" })).toBeDisabled()
})

test("LR8: a refused run says why in plain words", async () => {
  stubFetch([
    { match: "/api/learnings/runs", status: 400, body: { error: "noHarnessPath" } },
    {
      match: "/api/learnings",
      status: 200,
      body: { learnings: [], latestRun: null, canEdit: true },
    },
    { match: "/api/projects", status: 200, body: projectsBody },
  ])
  renderPage()
  const user = userEvent.setup()
  await screen.findByText("No learnings here yet")

  await user.click(screen.getByRole("button", { name: "Run now" }))

  expect(await screen.findByText(/LEARNINGS_HARNESS_PATH/)).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Run now" })).toBeEnabled()
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
    { match: "/api/projects", status: 200, body: projectsBody },
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
    { match: "/api/projects", status: 200, body: projectsBody },
  ])
  renderPage("/learnings?show=10")
  const user = userEvent.setup()

  expect(await screen.findByText("Learning number 10")).toBeInTheDocument()
  expect(screen.queryByText("Learning number 11")).not.toBeInTheDocument()

  await user.selectOptions(screen.getByRole("combobox", { name: "Show" }), "all")
  expect(screen.getByText("Learning number 12")).toBeInTheDocument()
  expect(screen.getByText("Showing 12 of 12")).toBeInTheDocument()

  // Changing project keeps the chosen count.
  await user.selectOptions(screen.getByRole("combobox", { name: "Project" }), "p-2")
  expect(await screen.findByText("Learning number 12")).toBeInTheDocument()
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
    { match: "/api/projects", status: 200, body: projectsBody },
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
  expect(screen.getByTestId("location")).toHaveTextContent(/^\/learnings$/)
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
    { match: "/api/projects", status: 200, body: projectsBody },
  ])
  renderPage("/learnings?show=skipped")
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
    { match: "/api/projects", status: 200, body: projectsBody },
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
    { match: "/api/projects", status: 200, body: projectsBody },
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
    { match: "/api/projects", status: 200, body: projectsBody },
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
