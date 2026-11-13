import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Route, Routes } from "react-router-dom"
import { afterEach, expect, test, vi } from "vitest"
import { TestRouter } from "../tests/test-router.js"
import { RunPage } from "./RunPage.js"

const RUN = {
  id: "r-1",
  projectId: "p-1",
  status: "done",
  harnessRef: "abc123",
  error: null,
  startedAt: "2026-10-20T10:00:00.000Z",
  finishedAt: "2026-10-20T10:08:00.000Z",
}

const LEARNING = {
  id: "l-1",
  title: "Helpers report while their test run is still going",
  cause: "The implement skill never tells helpers to wait for a test run to exit.",
  problem: "Coder agents end their turn saying they are waiting on jest.",
  priority: "high",
  priorityReason: "it keeps happening",
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
}

/** The run's list row: the fix plus the counts and mark only a list read carries. */
const ROW = {
  ...LEARNING,
  problemCount: 9,
  sessionCount: 6,
  firstSeenAt: null,
  lastSeenAt: null,
  sessionsLast7Days: 0,
  runMark: "new",
}

const stubFetch = () =>
  vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = input instanceof Request ? input.url : String(input)
    const body = url.includes("/api/learnings/l-1/decision")
      ? {
          learning: { ...LEARNING, decision: "accepted", decidedAt: new Date().toISOString() },
        }
      : url.includes("/api/learnings/runs/r-1")
        ? { run: RUN }
        : { learnings: [ROW], latestRun: RUN, canEdit: true }
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))
  })

afterEach(() => {
  vi.restoreAllMocks()
})

test("accepting a fix on the run page updates its card in place, keeping its counts and run mark", async () => {
  stubFetch()
  render(
    <TestRouter initialEntries={["/projects/p-1/runs/r-1"]}>
      <Routes>
        <Route path="/projects/:id/*" element={<RunPage projectId="p-1" runId="r-1" />} />
      </Routes>
    </TestRouter>,
  )
  const user = userEvent.setup()

  const card = (await screen.findByText(LEARNING.title)).closest("article") as HTMLElement
  await user.click(within(card).getByRole("button", { name: "Accept" }))

  expect(await within(card).findByText(/^Accepted/)).toBeInTheDocument()
  expect(within(card).queryByRole("button", { name: "Accept" })).toBeNull()
  expect(within(card).getByRole("button", { name: "Skip" })).toBeInTheDocument()
  expect(within(card).getByRole("button", { name: "Reject" })).toBeInTheDocument()
  expect(within(card).getByText(/9 problems in 6 sessions/)).toBeInTheDocument()
  expect(within(card).getByText("new")).toBeInTheDocument()
  expect(screen.getByText(/1 new fix, 0 updated/)).toBeInTheDocument()
})
