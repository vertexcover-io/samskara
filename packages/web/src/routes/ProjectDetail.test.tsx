import { cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import type {
  LearningRun,
  LearningSummary,
  ListedRun,
  ProjectDetail as ProjectDetailPayload,
  SessionSummary,
} from "../api/types.js"
import { TestRouter } from "../tests/test-router.js"
import { ProjectDetail } from "./ProjectDetail.js"

const PROJECT: ProjectDetailPayload = {
  id: "p-1",
  name: "samskara",
  slug: "samskara",
  owner: { type: "user", slug: "kgritesh" },
  sessionCount: 12,
  lastActiveAt: "2026-02-01T09:30:00.000Z",
  repo: null,
  autoReview: false,
  fixRunEveryDays: 7,
}

const session = (id: string, title: string): SessionSummary => ({
  id,
  title,
  projectId: "p-1",
  projectName: "samskara",
  projectSlug: "samskara",
  userLogin: "maya",
  tags: [],
  messageCount: 42,
  status: "complete",
  startedAt: "2026-02-01T08:30:00.000Z",
  lastActiveAt: "2026-02-01T09:30:00.000Z",
  hasAiReview: false,
})

const LEARNING: LearningSummary = {
  id: "l-1",
  projectId: "p-1",
  title: "Helpers report while their test run is still going",
  cause: "The implement skill never tells helpers to wait for a test run to exit.",
  problem: "Coder agents end their turn saying they are waiting on jest.",
  priority: "high",
  priorityReason: "it keeps happening",
  fixType: "skill",
  fix: "Wait for the test command to exit before reporting.",
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
  runMark: null,
}

const renderDetail = (
  project: ProjectDetailPayload,
  options: {
    entry?: string
    viewerCanDelete?: boolean
    sessions?: ReadonlyArray<SessionSummary>
    runs?: ReadonlyArray<ListedRun>
    run?: LearningRun
    learnings?: ReadonlyArray<LearningSummary>
    viewerCanEdit?: boolean
    patch?: { status: number; body: unknown }
  } = {},
) => {
  const {
    entry = "/projects/p-1",
    viewerCanDelete = false,
    sessions = [],
    runs = [],
    run,
    learnings = [LEARNING],
    viewerCanEdit = false,
    patch,
  } = options
  const urls: string[] = []
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    const method = input instanceof Request ? input.method : (init?.method ?? "GET")
    if (method === "PATCH") {
      // Recorded as "PATCH url body", so a test can read what each save sent.
      const body = input instanceof Request ? await input.clone().text() : String(init?.body)
      urls.push(`PATCH ${url} ${body}`)
      return new Response(JSON.stringify(patch?.body ?? JSON.parse(body)), {
        status: patch?.status ?? 200,
      })
    }
    urls.push(url)
    if (url.includes("/api/learnings/runs/")) {
      return Promise.resolve(new Response(JSON.stringify({ run }), { status: 200 }))
    }
    if (url.includes("/api/learnings/runs")) {
      return Promise.resolve(
        new Response(JSON.stringify({ runs, canEdit: true, reviewsWaiting: 0 }), { status: 200 }),
      )
    }
    if (url.includes("/api/learnings")) {
      return Promise.resolve(
        new Response(JSON.stringify({ learnings, latestRun: null, canEdit: true }), {
          status: 200,
        }),
      )
    }
    if (url.includes("/api/sessions")) {
      return Promise.resolve(
        new Response(JSON.stringify({ sessions, nextCursor: null }), { status: 200 }),
      )
    }
    if (url.includes("/api/projects/")) {
      return Promise.resolve(
        new Response(JSON.stringify({ project, viewerCanDelete, viewerCanEdit }), { status: 200 }),
      )
    }
    return Promise.resolve(new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }))
  })

  render(
    <TestRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/projects/:id/*" element={<ProjectDetail />} />
      </Routes>
    </TestRouter>,
  )
  return urls
}

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

test("SC1: a project page shows the project's name, slug, owner and session count, with a link to its sessions", async () => {
  renderDetail(PROJECT)

  await screen.findByRole("heading", { name: "samskara" })
  // Name and slug are both literally "samskara" here, so both must be on the page at once.
  expect(screen.getAllByText("samskara")).toHaveLength(2)
  expect(screen.getByText("kgritesh")).toBeInTheDocument()
  expect(screen.getByText("12")).toBeInTheDocument()
  expect(screen.getByRole("link", { name: /sessions/i })).toHaveAttribute(
    "href",
    "/sessions?project=p-1",
  )
})

test("SC2: the owner line follows who owns the project - org slug marked as an org, user login not marked", async () => {
  renderDetail({
    ...PROJECT,
    owner: { type: "org", slug: "vertexcover-io" },
  })

  await waitFor(() => expect(screen.getByText(/vertexcover-io/)).toBeInTheDocument())
  expect(screen.getByRole("link", { name: /org · vertexcover-io/ })).toHaveAttribute(
    "href",
    "/orgs/vertexcover-io",
  )
  cleanup()

  renderDetail({ ...PROJECT, owner: { type: "user", slug: "kgritesh" } })

  await waitFor(() => expect(screen.getByText("kgritesh")).toBeInTheDocument())
  expect(screen.queryByText(/org ·/)).not.toBeInTheDocument()
})

test("SC10: a viewer who may not delete is offered no delete control", async () => {
  renderDetail(PROJECT, { viewerCanDelete: false })

  await screen.findByRole("heading", { name: "samskara" })
  expect(screen.queryByRole("button", { name: /delete project/i })).not.toBeInTheDocument()
})

test("SC10: a project with a linked repo renders it as a GitHub link, and a remoteless project shows no repo field", async () => {
  renderDetail({
    ...PROJECT,
    repo: { host: "github.com", owner: "vertexcover-io", repoName: "samskara" },
  })

  await screen.findByRole("heading", { name: "samskara" })
  expect(screen.getByRole("link", { name: "vertexcover-io/samskara" })).toHaveAttribute(
    "href",
    "https://github.com/vertexcover-io/samskara",
  )
  expect(screen.getByText("Repository")).toBeInTheDocument()
  cleanup()

  renderDetail(PROJECT)
  await screen.findByRole("heading", { name: "samskara" })
  expect(screen.queryByText("Repository")).not.toBeInTheDocument()
})

const tabRow = () => screen.getByRole("navigation", { name: "Project" })
const projectFetches = (urls: ReadonlyArray<string>) =>
  urls.filter((url) => !url.startsWith("PATCH") && url.includes("/api/projects/p-1")).length

test("SC705: the project page opens on Overview with the tab row (Overview, Fixes, Runs, Settings), its fields and recent sessions, and loads no fixes", async () => {
  const urls = renderDetail(PROJECT, {
    sessions: [session("s-1", "Port the detail page"), session("s-2", "Fix the sync bar")],
  })

  await screen.findByRole("heading", { name: "samskara" })
  expect(
    within(tabRow())
      .getAllByRole("link")
      .map((link) => link.textContent),
  ).toEqual(["Overview", "Fixes", "Runs", "Settings"])
  expect(within(tabRow()).getByRole("link", { name: "Overview" })).toHaveAttribute(
    "aria-current",
    "page",
  )
  expect(screen.getByText("Recent sessions")).toBeInTheDocument()
  expect(await screen.findByText("Port the detail page")).toBeInTheDocument()
  expect(screen.getByText("Fix the sync bar")).toBeInTheDocument()
  expect(urls.some((url) => url.includes("/api/learnings"))).toBe(false)
})

test("SC706: clicking Fixes shows the project's fixes, puts the tab in the URL and hides Overview", async () => {
  const urls = renderDetail(PROJECT)
  const user = userEvent.setup()
  await screen.findByRole("heading", { name: "samskara" })

  await user.click(within(tabRow()).getByRole("link", { name: "Fixes" }))

  expect(await screen.findByText(LEARNING.title)).toBeInTheDocument()
  expect(screen.getByTestId("location")).toHaveTextContent(/^\/projects\/p-1\/fixes$/)
  expect(within(tabRow()).getByRole("link", { name: "Fixes" })).toHaveAttribute(
    "aria-current",
    "page",
  )
  expect(urls.some((url) => url.includes("/api/learnings?project=p-1"))).toBe(true)
  expect(screen.queryByText("Recent sessions")).toBeNull()
  expect(screen.queryByRole("combobox", { name: "Project" })).toBeNull()
  expect(screen.queryByRole("button", { name: "Run now" })).toBeNull()
})

test("SC707: a reload on the Fixes tab lands on the Fixes tab with its Show choice, fetching the project once", async () => {
  const urls = renderDetail(PROJECT, { entry: "/projects/p-1/fixes?show=10" })

  expect(await screen.findByText(LEARNING.title)).toBeInTheDocument()
  expect(within(tabRow()).getByRole("link", { name: "Fixes" })).toHaveAttribute(
    "aria-current",
    "page",
  )
  expect(screen.getByRole("combobox", { name: "Show" })).toHaveValue("10")
  expect(projectFetches(urls)).toBe(1)
})

test("SC708: a path no tab owns falls back to Overview", async () => {
  renderDetail(PROJECT, { entry: "/projects/p-1/nope" })

  await screen.findByRole("heading", { name: "samskara" })
  await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/projects\/p-1$/))
  expect(within(tabRow()).getByRole("link", { name: "Overview" })).toHaveAttribute(
    "aria-current",
    "page",
  )
})

const listedRun = (id: string, fields: Partial<ListedRun> = {}): ListedRun => ({
  id,
  projectId: "p-1",
  status: "done",
  harnessRef: null,
  error: null,
  startedAt: "2026-11-10T10:00:00.000Z",
  finishedAt: "2026-11-10T10:08:00.000Z",
  fixesCreated: 0,
  fixesUpdated: 0,
  ...fields,
})

test("SC728: the Runs tab says how often runs come and lists runs as cards that open their run", async () => {
  renderDetail(
    { ...PROJECT, fixRunEveryDays: 3 },
    {
      entry: "/projects/p-1/runs",
      runs: [
        listedRun("r-2", {
          status: "running",
          finishedAt: null,
          startedAt: "2026-11-12T09:00:00.000Z",
        }),
        listedRun("r-1", {
          status: "failed",
          error: "harness timed out",
          startedAt: "2026-11-11T09:00:00.000Z",
        }),
        listedRun("r-0", { fixesCreated: 1, fixesUpdated: 2 }),
      ],
      run: listedRun("r-0"),
    },
  )
  const user = userEvent.setup()

  expect(await screen.findByText("Automatic fix run every 3 days")).toBeInTheDocument()
  expect(screen.getByText(/^Last run .* · running$/)).toBeInTheDocument()
  expect(within(tabRow()).getByRole("link", { name: "Runs" })).toHaveAttribute(
    "aria-current",
    "page",
  )
  const cards = screen.getAllByRole("article")
  expect(cards.map((card) => within(card).getByRole("link").getAttribute("href"))).toEqual([
    "/projects/p-1/runs/r-2",
    "/projects/p-1/runs/r-1",
    "/projects/p-1/runs/r-0",
  ])
  const [running, failed, done] = cards as [HTMLElement, HTMLElement, HTMLElement]
  expect(within(running).getByText("running")).toBeInTheDocument()
  expect(running).toHaveTextContent("running… · 0 new fixes, 0 updated")
  expect(within(failed).getByText("failed")).toBeInTheDocument()
  expect(within(failed).getByText("harness timed out")).toBeInTheDocument()
  expect(done).toHaveTextContent(/finished .* · 1 new fix, 2 updated/)

  await user.click(within(done).getByRole("link"))
  expect(screen.getByTestId("location")).toHaveTextContent(/^\/projects\/p-1\/runs\/r-0$/)
})

test("SC729: a project with no runs says so", async () => {
  renderDetail(PROJECT, { entry: "/projects/p-1/runs", runs: [] })

  expect(await screen.findByText("No fix runs yet")).toBeInTheDocument()
  expect(screen.getByText("No fix run yet")).toBeInTheDocument()
  expect(screen.queryByRole("article")).toBeNull()
})

test("SC730: a run's page lists the fixes it touched, marked new or updated, with a way back to all runs", async () => {
  const urls = renderDetail(PROJECT, {
    entry: "/projects/p-1/runs/r-0",
    run: {
      id: "r-0",
      projectId: "p-1",
      status: "done",
      harnessRef: null,
      error: null,
      startedAt: "2026-11-10T10:00:00.000Z",
      finishedAt: "2026-11-10T10:08:00.000Z",
    },
    learnings: [
      { ...LEARNING, id: "l-1", title: "L1", runMark: "updated" },
      { ...LEARNING, id: "l-3", title: "L3", runMark: "new" },
    ],
  })

  expect(await screen.findByText("L1")).toBeInTheDocument()
  expect(urls.some((url) => url.includes("/api/learnings/runs/r-0"))).toBe(true)
  expect(urls.some((url) => url.includes("/api/learnings?project=p-1&run=r-0"))).toBe(true)
  expect(within(tabRow()).getByRole("link", { name: "Runs" })).toHaveAttribute(
    "aria-current",
    "page",
  )
  expect(screen.getByRole("heading", { name: /^Run · / })).toBeInTheDocument()
  expect(screen.getByText(/finished .* · 1 new fix, 1 updated/)).toHaveTextContent(/^done/)
  const cards = screen.getAllByRole("article")
  expect(cards.map((card) => within(card).getByRole("link").textContent)).toEqual(["L1", "L3"])
  expect(within(cards[0] as HTMLElement).getByText("updated")).toBeInTheDocument()
  expect(within(cards[1] as HTMLElement).getByText("new")).toBeInTheDocument()
  expect(screen.getByRole("link", { name: "← All runs" })).toHaveAttribute(
    "href",
    "/projects/p-1/runs",
  )
})

test("a run of another project, opened under this one, is not shown as this project's run", async () => {
  renderDetail(PROJECT, {
    entry: "/projects/p-1/runs/r-9",
    run: {
      id: "r-9",
      projectId: "p-2",
      status: "done",
      harnessRef: null,
      error: null,
      startedAt: "2026-11-10T10:00:00.000Z",
      finishedAt: "2026-11-10T10:08:00.000Z",
    },
    learnings: [],
  })

  expect(await screen.findByRole("alert")).toHaveTextContent("This project has no such run.")
  expect(screen.queryByRole("heading", { name: /^Run · / })).toBeNull()
  expect(screen.getByRole("link", { name: "← All runs" })).toHaveAttribute(
    "href",
    "/projects/p-1/runs",
  )
})

const patches = (urls: ReadonlyArray<string>) =>
  urls.filter((url) => url.startsWith("PATCH")).map((url) => url.slice(url.lastIndexOf(" ") + 1))
const daysField = () => screen.getByRole("spinbutton", { name: "Days between automatic fix runs" })

test("SC748: an admin saves automatic review and the fix-run interval, and Runs reads the new interval", async () => {
  const urls = renderDetail(
    { ...PROJECT, autoReview: true },
    { entry: "/projects/p-1/settings", viewerCanEdit: true },
  )
  const user = userEvent.setup()

  const autoReview = await screen.findByRole("checkbox", { name: "On" })
  expect(within(tabRow()).getByRole("link", { name: "Settings" })).toHaveAttribute(
    "aria-current",
    "page",
  )
  await user.click(autoReview)
  await waitFor(() => expect(patches(urls)).toEqual(['{"autoReview":false}']))
  await user.clear(daysField())
  await user.type(daysField(), "3")
  await user.click(screen.getByRole("button", { name: "Save" }))

  await waitFor(() =>
    expect(patches(urls)).toEqual(['{"autoReview":false}', '{"fixRunEveryDays":3}']),
  )
  expect(
    urls.filter((url) => url.startsWith("PATCH")).every((url) => url.includes("/api/projects/p-1")),
  ).toBe(true)
  expect(await screen.findByText("Saved")).toBeInTheDocument()
  await user.click(within(tabRow()).getByRole("link", { name: "Runs" }))
  expect(await screen.findByText("Automatic fix run every 3 days")).toBeInTheDocument()
  expect(projectFetches(urls)).toBe(1)
})

test.each([
  ["7", false],
  ["0", false],
  ["", false],
  ["2.5", false],
  ["3651", false],
  ["3", true],
  ["3650", true],
])("SC749: with %j in the days field, Save is enabled: %s", async (typed, enabled) => {
  renderDetail(PROJECT, { entry: "/projects/p-1/settings", viewerCanEdit: true })
  const user = userEvent.setup()
  await screen.findByRole("checkbox", { name: "On" })

  await user.clear(daysField())
  if (typed !== "") await user.type(daysField(), typed)

  const save = screen.getByRole("button", { name: "Save" })
  if (enabled) expect(save).toBeEnabled()
  else expect(save).toBeDisabled()
})

test("SC750: a refused save says why and puts the saved value back", async () => {
  renderDetail(PROJECT, {
    entry: "/projects/p-1/settings",
    viewerCanEdit: true,
    patch: { status: 403, body: { error: "forbidden" } },
  })
  const user = userEvent.setup()
  await screen.findByRole("checkbox", { name: "On" })

  await user.clear(daysField())
  await user.type(daysField(), "3")
  await user.click(screen.getByRole("button", { name: "Save" }))

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Only a project admin can change these settings.",
  )
  expect(daysField()).toHaveValue(7)
})

test("SC751: someone who is not an admin sees the settings as text, with no controls", async () => {
  renderDetail(PROJECT, { entry: "/projects/p-1/settings", viewerCanEdit: false })

  expect(await screen.findByText("Off")).toBeInTheDocument()
  expect(screen.getByText("7 days")).toBeInTheDocument()
  expect(screen.getByText("Only a project admin can change these.")).toBeInTheDocument()
  expect(screen.queryByRole("checkbox")).toBeNull()
  expect(screen.queryByRole("spinbutton")).toBeNull()
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull()
})
