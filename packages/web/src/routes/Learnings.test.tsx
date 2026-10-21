import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { TestRouter } from "../tests/test-router.js"
import { Learnings } from "./Learnings.js"

const LEARNING = {
  id: "l-1",
  title: "Helpers report while their test run is still going",
  cause: "The implement skill never tells helpers to wait for a test run to exit.",
  problem: "Coder agents end their turn saying they are waiting on jest.",
  priority: "high",
  priorityReason: "it keeps happening, and two sessions shipped untested work",
  fixType: "skill",
  fix: "In skills/implement/SKILL.md, wait for the test command to exit before reporting.",
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

const PROBLEM = {
  id: "pr-1",
  sessionId: "s-9",
  reviewId: "rv-1",
  projectId: "p-1",
  title: "Coder reported while jest was still running",
  class: "agent",
  severity: "high",
  severityReason: "the orchestrator had to chase it",
  fixType: "skill",
  description: "The coder ended its turn with jest still running.",
  learning: "Wait for the test run to exit.",
  evidence: [],
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

/** Answers by URL substring, first match wins, and records every URL asked for. */
const stubFetch = (routes: ReadonlyArray<{ match: string; status: number; body: unknown }>) => {
  const urls: string[] = []
  vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = input instanceof Request ? input.url : String(input)
    urls.push(url)
    const route = routes.find((r) => url.includes(r.match))
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
  vi.restoreAllMocks()
})

test("LR1: shows the first project's learnings with priority, counts, fix and the last run", async () => {
  const urls = stubFetch([
    { match: "/api/learnings", status: 200, body: { learnings: [LEARNING], latestRun: RUN } },
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

test("LR2: Show problems lists the problems behind a learning, each linking to its session", async () => {
  stubFetch([
    { match: "/api/learnings/l-1", status: 200, body: { learning: LEARNING, problems: [PROBLEM] } },
    { match: "/api/learnings", status: 200, body: { learnings: [LEARNING], latestRun: RUN } },
    { match: "/api/projects", status: 200, body: projectsBody },
  ])

  renderPage()
  const user = userEvent.setup()
  const card = (await screen.findByText(LEARNING.title)).closest("article") as HTMLElement
  await user.click(within(card).getByRole("button", { name: "Show problems" }))

  expect(await within(card).findByText(PROBLEM.title)).toBeInTheDocument()
  expect(within(card).getByRole("link", { name: "the session" })).toHaveAttribute(
    "href",
    "/sessions/s-9?tab=review",
  )
})

test("LR3: choosing another project loads that project's learnings", async () => {
  const urls = stubFetch([
    { match: "/api/learnings", status: 200, body: { learnings: [LEARNING], latestRun: RUN } },
    { match: "/api/projects", status: 200, body: projectsBody },
  ])

  renderPage()
  const user = userEvent.setup()
  await screen.findByText(LEARNING.title)
  await user.selectOptions(screen.getByRole("combobox"), "p-2")

  await waitFor(() => {
    expect(urls.some((url) => url.includes("/api/learnings?project=p-2"))).toBe(true)
  })
})

test("LR4: a project with no learnings says when they appear", async () => {
  stubFetch([
    { match: "/api/learnings", status: 200, body: { learnings: [], latestRun: null } },
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
