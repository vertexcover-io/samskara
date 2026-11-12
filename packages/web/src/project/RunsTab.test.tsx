import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import type { ListedRun } from "../api/types.js"
import { TestRouter } from "../tests/test-router.js"
import { RUN_POLL_MS, RunsTab } from "./RunsTab.js"

const run = (id: string, fields: Partial<ListedRun> = {}): ListedRun => ({
  id,
  status: "done",
  harnessRef: null,
  error: null,
  startedAt: "2026-11-10T10:00:00.000Z",
  finishedAt: "2026-11-10T10:08:00.000Z",
  fixesCreated: 0,
  fixesUpdated: 0,
  ...fields,
})

type ListBody = {
  readonly runs: ReadonlyArray<ListedRun>
  readonly reviewsWaiting: number
  readonly canEdit: boolean
}
const list = (runs: ReadonlyArray<ListedRun>, reviewsWaiting = 0, canEdit = true): ListBody => ({
  runs,
  reviewsWaiting,
  canEdit,
})

type Call = { readonly method: string; readonly url: string; readonly body: unknown }

/**
 * The runs list answers each read with the next of `lists` (the last one repeats), and a Run now
 * POST answers `post`. Records every call with its method, URL and JSON body.
 */
const stubServer = (
  lists: ReadonlyArray<ListBody>,
  post: { readonly status: number; readonly body: unknown } = {
    status: 202,
    body: { runId: "r-new" },
  },
) => {
  const calls: Call[] = []
  let reads = 0
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    const method = input instanceof Request ? input.method : (init?.method ?? "GET")
    const text = input instanceof Request ? await input.clone().text() : init?.body
    calls.push({ method, url, body: text ? JSON.parse(String(text)) : null })
    if (method === "POST") return new Response(JSON.stringify(post.body), { status: post.status })
    if (!url.includes("/api/learnings/runs"))
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })
    const body = lists[Math.min(reads, lists.length - 1)]
    reads += 1
    return new Response(JSON.stringify(body), { status: 200 })
  })
  return calls
}

const posts = (calls: ReadonlyArray<Call>) => calls.filter((call) => call.method === "POST")
const listReads = (calls: ReadonlyArray<Call>) =>
  calls.filter((call) => call.method === "GET" && call.url.includes("/api/learnings/runs"))

const renderTab = () =>
  render(
    <TestRouter initialEntries={["/projects/p-1/runs"]}>
      <RunsTab projectId="p-1" fixRunEveryDays={1} />
    </TestRouter>,
  )

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

test("SC734: with nothing pending, Run now starts at once without asking and the list shows the new run", async () => {
  const calls = stubServer([
    list([run("r-0")]),
    list([run("r-0")]),
    list([run("r-new", { status: "waiting", finishedAt: null }), run("r-0")]),
  ])
  renderTab()
  const user = userEvent.setup()
  await screen.findByText(/^Last run /)

  await user.click(screen.getByRole("button", { name: "Run now" }))

  await waitFor(() => expect(posts(calls)).toHaveLength(1))
  expect(posts(calls)[0]?.body).toEqual({ project: "p-1" })
  expect(screen.queryByRole("dialog")).toBeNull()
  await waitFor(() => expect(screen.getAllByRole("article")).toHaveLength(2))
  expect(screen.getByText(/waiting to start/)).toBeInTheDocument()
})

test.each([
  ["Wait for them", true],
  ["Run anyway", false],
])(
  "SC735: with reviews pending, %s posts waitForReviews %s and closes the dialog",
  async (choice, flag) => {
    const calls = stubServer([list([run("r-0")], 3)])
    renderTab()
    const user = userEvent.setup()
    await screen.findByText(/^Last run /)

    await user.click(screen.getByRole("button", { name: "Run now" }))
    const dialog = await screen.findByRole("dialog")
    expect(
      within(dialog).getByRole("heading", { name: "3 reviews are still waiting or running" }),
    ).toBeInTheDocument()
    await user.click(within(dialog).getByRole("button", { name: choice }))

    await waitFor(() => expect(posts(calls)).toHaveLength(1))
    expect(posts(calls)[0]?.body).toEqual({ project: "p-1", waitForReviews: flag })
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  },
)

test("SC736: Cancel in the dialog starts nothing", async () => {
  const calls = stubServer([list([run("r-0")], 1)])
  renderTab()
  const user = userEvent.setup()
  await screen.findByText(/^Last run /)

  await user.click(screen.getByRole("button", { name: "Run now" }))
  const dialog = await screen.findByRole("dialog")
  expect(
    within(dialog).getByRole("heading", { name: "1 review is still waiting or running" }),
  ).toBeInTheDocument()
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }))

  expect(screen.queryByRole("dialog")).toBeNull()
  expect(posts(calls)).toEqual([])
})

test("SC737: a run already open is pointed at, not started again", async () => {
  const calls = stubServer([
    list([run("r-0")]),
    list([run("r-9", { status: "waiting", finishedAt: null }), run("r-0")]),
  ])
  renderTab()
  const user = userEvent.setup()
  await screen.findByText(/^Last run /)

  await user.click(screen.getByRole("button", { name: "Run now" }))

  const notice = await screen.findByRole("status")
  expect(notice).toHaveTextContent("A fix run is already waiting to start.")
  expect(within(notice).getByRole("link", { name: "See that run" })).toHaveAttribute(
    "href",
    "/projects/p-1/runs/r-9",
  )
  expect(posts(calls)).toEqual([])
  expect(screen.queryByRole("alert")).toBeNull()
})

test("SC738: a 409 from the server turns into the same pointer at the open run", async () => {
  stubServer(
    [
      list([run("r-0")]),
      list([run("r-0")]),
      list([run("r-9", { status: "running", finishedAt: null }), run("r-0")]),
    ],
    { status: 409, body: { error: "learningRunAlreadyRunning", runId: "r-9" } },
  )
  renderTab()
  const user = userEvent.setup()
  await screen.findByText(/^Last run /)

  await user.click(screen.getByRole("button", { name: "Run now" }))

  const notice = await screen.findByRole("status")
  expect(notice).toHaveTextContent("A fix run is already running.")
  expect(within(notice).getByRole("link", { name: "See that run" })).toHaveAttribute(
    "href",
    "/projects/p-1/runs/r-9",
  )
  expect(screen.queryByText(/The server responded with 409/)).toBeNull()
})

test("SC739: a refused run says why in plain words", async () => {
  stubServer([list([run("r-0")])], { status: 400, body: { error: "noHarnessPath" } })
  renderTab()
  const user = userEvent.setup()
  await screen.findByText(/^Last run /)

  await user.click(screen.getByRole("button", { name: "Run now" }))

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "The server has no harness to check learnings against",
  )
  expect(screen.getByRole("button", { name: "Run now" })).toBeEnabled()
})

test("SC740: an open run is followed until it ends, and then the polling stops", async () => {
  const calls = stubServer([
    list([run("r-2", { status: "running", finishedAt: null })]),
    list([run("r-2", { fixesCreated: 1 })]),
  ])
  // Only the poll's interval is faked, so fetches still settle on real time.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
  renderTab()

  expect(await screen.findByText(/running… · 0 new fixes, 0 updated/)).toBeInTheDocument()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(RUN_POLL_MS)
  })
  expect(await screen.findByText(/finished .* · 1 new fix, 0 updated/)).toBeInTheDocument()
  const readsWhenDone = listReads(calls).length
  await act(async () => {
    await vi.advanceTimersByTimeAsync(RUN_POLL_MS * 2)
  })
  expect(listReads(calls)).toHaveLength(readsWhenDone)
})

test("SC741: a viewer is offered no Run now", async () => {
  stubServer([list([run("r-0")], 0, false)])
  renderTab()

  await screen.findByText(/^Last run /)
  expect(screen.queryByRole("button", { name: "Run now" })).toBeNull()
})
