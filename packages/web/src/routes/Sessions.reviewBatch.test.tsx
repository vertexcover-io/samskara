import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, test, vi } from "vitest"
import { AppRoutes } from "../App.js"
import type { CurrentUser, ReviewBatchView, SessionSummary } from "../api/types.js"
import { TestRouter } from "../tests/test-router.js"

const user: CurrentUser = {
  id: "u-1",
  githubLogin: "e2e-user",
  email: "e2e@example.com",
  name: "E2E User",
  avatarUrl: null,
  isSuperAdmin: false,
}

const row = (id: string, title: string): SessionSummary => ({
  id,
  title,
  projectId: "p-a",
  projectName: "A",
  projectSlug: "a",
  userLogin: "maya",
  tags: [],
  messageCount: 3,
  status: "complete",
  startedAt: "2026-02-01T08:30:00.000Z",
  lastActiveAt: "2026-02-01T09:30:00.000Z",
  hasAiReview: false,
})

const first = row("s-1", "First session")
const second = row("s-2", "Second session")

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const runningBatch: ReviewBatchView = {
  batchId: "b-1",
  status: "running",
  startedAt: "2026-11-02T10:00:00.000Z",
  sessions: [
    { sessionId: "s-1", projectId: "p-a", state: "reviewing", reason: null },
    { sessionId: "s-2", projectId: "p-a", state: "waiting", reason: null },
  ],
  projects: [{ projectId: "p-a", name: "A", state: "waiting", reason: null }],
}

const doneBatch: ReviewBatchView = {
  ...runningBatch,
  status: "done",
  sessions: runningBatch.sessions.map((session) => ({ ...session, state: "reviewed" })),
  projects: [{ projectId: "p-a", name: "A", state: "done", reason: null }],
}

type Handlers = {
  readonly list?: (url: URL) => unknown
  /** A Response is sent as it is, such as a 401. */
  readonly current?: () => ReviewBatchView | null | Response
  readonly start?: (body: unknown) => Response
}

type Calls = { list: string[]; current: number; starts: unknown[] }

const listOf = (rows: ReadonlyArray<SessionSummary>, total = rows.length) => ({
  sessions: rows,
  pagination: { page: 1, limit: 50, total, totalPages: Math.ceil(total / 50) },
})

const stubFetch = (handlers: Handlers): Calls => {
  const calls: Calls = { list: [], current: 0, starts: [] }
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === "string" ? input : input.toString()
    if (path.endsWith("/api/auth/me")) return Promise.resolve(jsonResponse(200, user))
    if (path === "/api/sessions/filters")
      return Promise.resolve(
        jsonResponse(200, { projects: [], authors: [], repositories: [], branches: [], tags: [] }),
      )
    if (path === "/api/review-batches/current") {
      calls.current += 1
      const answer = handlers.current?.() ?? null
      return Promise.resolve(
        answer instanceof Response ? answer : jsonResponse(200, { batch: answer }),
      )
    }
    if (path === "/api/review-batches" && init?.method === "POST") {
      const body: unknown = JSON.parse(String(init.body))
      calls.starts.push(body)
      return Promise.resolve(
        handlers.start?.(body) ?? jsonResponse(202, { batchId: "b-1", notAllowed: [] }),
      )
    }
    if (path === "/api/sessions" || path.startsWith("/api/sessions?")) {
      calls.list.push(path)
      const url = new URL(path, "http://localhost")
      return Promise.resolve(jsonResponse(200, handlers.list?.(url) ?? listOf([first, second])))
    }
    return Promise.reject(new Error(`unstubbed fetch: ${path}`))
  })
  return calls
}

const renderAt = (path: string) =>
  render(
    <TestRouter initialEntries={[path]}>
      <AppRoutes />
    </TestRouter>,
  )

const summary = (): string =>
  screen.getByRole("region", { name: "Selected sessions" }).querySelector("p")?.textContent ?? ""

const rowBox = (title: string) => screen.getByRole("checkbox", { name: `Select ${title}` })
const pageBox = () => screen.getByRole("checkbox", { name: "Select this page" })

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

test("SC21: row checkboxes and Select this page pick sessions and update the bar, without opening a session", async () => {
  stubFetch({})
  renderAt("/sessions")
  await screen.findByRole("link", { name: /first session/i })

  await userEvent.click(rowBox("First session"))
  expect(summary()).toBe("1 selected · about 6 min")
  expect(screen.getByTestId("location").textContent).toBe("/sessions")

  await userEvent.click(pageBox())
  expect(summary()).toBe("2 selected · about 7 min")
  expect(rowBox("First session")).toBeChecked()
  expect(rowBox("Second session")).toBeChecked()

  await userEvent.click(pageBox())
  expect(summary()).toBe("0 selected")
  expect(screen.getByTestId("location").textContent).toBe("/sessions")
})

test("SC22: Select all N matching picks the first 50 matching sessions across pages", async () => {
  const fifty = Array.from({ length: 50 }, (_, index) => row(`m-${index}`, `Matching ${index}`))
  const calls = stubFetch({
    list: (url) =>
      url.searchParams.get("limit") === "50" ? listOf(fifty, 51) : listOf([first, second], 51),
  })
  renderAt("/sessions?tags=yok")
  await screen.findByRole("link", { name: /first session/i })

  await userEvent.click(screen.getByRole("button", { name: "Select the first 50 of 51 matching" }))

  await waitFor(() => expect(summary()).toBe("50 selected · about 55 min"))
  const selectAll = new URL(calls.list.at(-1) ?? "", "http://localhost")
  expect(selectAll.searchParams.get("tags")).toBe("yok")
  expect(selectAll.searchParams.get("page")).toBe("1")
  expect(selectAll.searchParams.get("limit")).toBe("50")
})

test("Select all N matching keeps sessions picked earlier, up to 50 in total", async () => {
  const fifty = Array.from({ length: 50 }, (_, index) => row(`m-${index}`, `Matching ${index}`))
  stubFetch({
    list: (url) =>
      url.searchParams.get("limit") === "50" ? listOf(fifty, 51) : listOf([first, second], 51),
  })
  renderAt("/sessions?tags=yok")
  await screen.findByRole("link", { name: /first session/i })
  await userEvent.click(screen.getByRole("checkbox", { name: "Select First session" }))

  await userEvent.click(screen.getByRole("button", { name: "Select the first 50 of 51 matching" }))

  await waitFor(() => expect(summary()).toBe("50 selected · about 55 min"))
  expect(screen.getByRole("checkbox", { name: "Select First session" })).toBeChecked()
})

test("SC23: starting sends the picked ids, clears the selection and shows the panel", async () => {
  let started = false
  const calls = stubFetch({
    current: () => (started ? runningBatch : null),
    start: () => {
      started = true
      return jsonResponse(202, { batchId: "b-1", notAllowed: [] })
    },
  })
  renderAt("/sessions")
  await screen.findByRole("link", { name: /first session/i })
  expect(screen.queryByRole("region", { name: "Review progress" })).toBeNull()

  await userEvent.click(pageBox())
  await userEvent.click(screen.getByRole("button", { name: "Review and find fixes" }))

  const panel = await screen.findByRole("region", { name: "Review progress" })
  expect(within(panel).getByText("Reviewing and finding fixes")).toBeInTheDocument()
  expect(calls.starts).toEqual([{ sessionIds: ["s-1", "s-2"] }])
  expect(summary()).toBe("0 selected")
})

test("SC24: a refused start shows a plain reason and keeps the selection", async () => {
  stubFetch({ start: () => jsonResponse(409, { error: "reviewBatchAlreadyRunning" }) })
  renderAt("/sessions")
  await screen.findByRole("link", { name: /first session/i })

  await userEvent.click(pageBox())
  await userEvent.click(screen.getByRole("button", { name: "Review and find fixes" }))

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "A review is already running. Wait for it to finish.",
  )
  expect(summary()).toBe("2 selected · about 7 min")
})

test("SC25: the panel comes back after a refresh and keeps checking until the batch is done", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
  const answers: ReviewBatchView[] = [runningBatch, doneBatch]
  const calls = stubFetch({ current: () => answers.shift() ?? doneBatch })
  renderAt("/sessions")

  const panel = await screen.findByRole("region", { name: "Review progress" })
  expect(within(panel).getByText("Reviewing and finding fixes")).toBeInTheDocument()
  expect(summary()).toBe("0 selected")

  await act(async () => {
    vi.advanceTimersByTime(3_000)
  })
  expect(await screen.findByText("Review finished")).toBeInTheDocument()
  expect(screen.getByRole("link", { name: "See fixes for A" })).toHaveAttribute(
    "href",
    "/learnings?project=p-a",
  )

  const checksWhenDone = calls.current
  await act(async () => {
    vi.advanceTimersByTime(10_000)
  })
  expect(calls.current).toBe(checksWhenDone)
})

test("a check that answers 401 while a batch runs stops the checks and sends the person to sign in", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
  const answers: Array<ReviewBatchView | Response> = [runningBatch]
  const calls = stubFetch({
    current: () => answers.shift() ?? jsonResponse(401, { error: "unauthorized" }),
  })
  renderAt("/sessions")
  await screen.findByRole("region", { name: "Review progress" })

  await act(async () => {
    vi.advanceTimersByTime(3_000)
  })
  // waitFor polls on setInterval, which is faked here, so flush the pending fetch by hand.
  for (let i = 0; i < 5; i += 1) await act(async () => {})
  expect(screen.getByTestId("location").textContent).toBe("/login")

  const checksAfterExpiry = calls.current
  await act(async () => {
    vi.advanceTimersByTime(10_000)
  })
  expect(calls.current).toBe(checksAfterExpiry)
})
