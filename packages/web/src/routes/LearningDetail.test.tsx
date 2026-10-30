import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import type { LearningProblem } from "../api/types.js"
import { TestRouter } from "../tests/test-router.js"
import { absoluteTime } from "../time.js"
import { bySession, LearningDetail } from "./LearningDetail.js"

const LEARNING = {
  id: "l-1",
  title: "Helpers report while their test run is still going",
  cause: "The implement skill never tells helpers to wait for a test run to exit.",
  problem: "Coder agents end their turn saying they are waiting on jest.",
  priority: "high",
  priorityReason: "it keeps happening, and two sessions shipped untested work",
  fixType: "skill",
  fix: "In skills/implement/SKILL.md, wait for the test command to exit before reporting.",
  impact: "wrong_result",
  impactReason: "two sessions shipped code whose tests had not finished",
  howItHelps: "Stops untested work from shipping.",
  fixSummary: "Make helpers wait for their tests to finish before reporting.",
  skippedAt: null,
  updatedByRunId: "r-1",
  createdAt: "2026-10-20T10:00:00.000Z",
  updatedAt: "2026-10-20T10:00:00.000Z",
}

const problem = (
  id: string,
  sessionId: string,
  sessionTitle: string | null,
  evidence: LearningProblem["evidence"],
): LearningProblem => ({
  id,
  sessionId,
  sessionTitle,
  reviewId: `rv-${sessionId}`,
  projectId: "p-1",
  title: `Problem ${id}`,
  class: "slow",
  severity: "high",
  severityReason: "the orchestrator had to chase it",
  fixType: "skill",
  description: "The coder ended its turn with jest still running.",
  learning: "Wait for the test run to exit.",
  evidence,
})

const quote = (text: string, messageId: string | null) => ({
  from: "msg-3",
  to: "msg-3",
  quote: text,
  why: `why ${text}`,
  messageId,
})

const PROBLEMS = [
  problem("1", "s-9", "Add the search page", [quote("waiting on jest", "m-uuid-1")]),
  problem("2", "s-4", "Fix the login bug", [quote("still running", null)]),
  problem("3", "s-9", "Add the search page", [quote("tests pending", "m-uuid-3")]),
]

const stubFetch = (status: number, body: unknown) =>
  vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(() => Promise.resolve(new Response(JSON.stringify(body), { status })))

const renderPage = (path = "/learnings/l-1") =>
  render(
    <TestRouter initialEntries={[path]}>
      <Routes>
        <Route path="/learnings/:learningId" element={<LearningDetail />} />
      </Routes>
    </TestRouter>,
  )

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

test("SC17: problems group by session in the order they came, each group with its session's title", () => {
  const groups = bySession(PROBLEMS)
  expect(groups.map((group) => group.sessionId)).toEqual(["s-9", "s-4"])
  expect(groups[0]?.title).toBe("Add the search page")
  expect(groups[0]?.problems.map((p) => p.id)).toEqual(["1", "3"])
})

test("SC20: the page shows the fix, and the proof by session with a link to each quote's message", async () => {
  stubFetch(200, { learning: LEARNING, problems: PROBLEMS })

  renderPage()

  const fix = await screen.findByRole("region", { name: "The fix" })
  expect(within(fix).getByRole("heading", { name: LEARNING.title })).toBeInTheDocument()
  expect(within(fix).getByText(LEARNING.problem)).toBeInTheDocument()
  expect(within(fix).getByText(/Wrong result/)).toBeInTheDocument()
  expect(within(fix).getByText(/two sessions shipped code/)).toBeInTheDocument()
  expect(within(fix).getByText(LEARNING.howItHelps)).toBeInTheDocument()
  expect(within(fix).getByText(/The fix \(Skill\)/)).toBeInTheDocument()
  expect(within(fix).getByText(LEARNING.fix)).toBeInTheDocument()
  expect(within(fix).getByText(LEARNING.fixSummary)).toBeInTheDocument()
  expect(within(fix).getByText("Exact change")).toBeInTheDocument()
  expect(within(fix).getByText("Why high")).toBeInTheDocument()
  expect(within(fix).getByText(/3 problems in 2 sessions/)).toBeInTheDocument()

  const proof = screen.getByRole("region", { name: "The proof" })
  const [first, second] = within(proof).getAllByRole("article")
  expect(within(first as HTMLElement).getByRole("heading")).toHaveTextContent(
    "Add the search page 2 problems",
  )
  expect(within(second as HTMLElement).getByRole("heading")).toHaveTextContent(
    "Fix the login bug 1 problem",
  )
  const links = within(first as HTMLElement).getAllByRole("link", { name: "Open in session" })
  expect(links.map((link) => link.getAttribute("href"))).toEqual([
    "/sessions/s-9?tab=conversation&m=m-uuid-1",
    "/sessions/s-9?tab=conversation&m=m-uuid-3",
  ])
  expect(within(second as HTMLElement).getByText("“still running”")).toBeInTheDocument()
  expect(within(second as HTMLElement).queryByRole("link")).toBeNull()
  expect(
    within(second as HTMLElement).getByRole("button", { name: "Show messages" }),
  ).toBeInTheDocument()
})

test("SC21: an older learning's page shows no Impact or How it helps block, and the rest", async () => {
  stubFetch(200, {
    learning: { ...LEARNING, impact: null, impactReason: null, howItHelps: null, fixSummary: null },
    problems: PROBLEMS,
  })

  renderPage()

  const fix = await screen.findByRole("region", { name: "The fix" })
  expect(within(fix).queryByText("Impact")).toBeNull()
  expect(within(fix).queryByText("How it helps")).toBeNull()
  expect(within(fix).getByText(LEARNING.fix)).toBeInTheDocument()
})

test("SC22: Back returns to the list with its project and Show kept", async () => {
  stubFetch(200, { learning: LEARNING, problems: PROBLEMS })

  renderPage("/learnings/l-1?project=p-2&show=all")

  await screen.findByRole("region", { name: "The fix" })
  expect(screen.getByRole("link", { name: /Back to Fixes/ })).toHaveAttribute(
    "href",
    "/learnings?project=p-2&show=all",
  )
})

test("SC24: a failed load says so, with the back link", async () => {
  stubFetch(404, { error: "learningNotFound" })

  renderPage()

  const alert = await screen.findByRole("alert")
  expect(within(alert).getByText("Retrieval failed")).toBeInTheDocument()
  expect(screen.getByRole("link", { name: /Back to Fixes/ })).toHaveAttribute("href", "/learnings")
})

test("SC34: a viewer sees no Skip or Unskip button on the fix page", async () => {
  stubFetch(200, { learning: LEARNING, problems: PROBLEMS, canEdit: false })

  renderPage()

  const fix = await screen.findByRole("region", { name: "The fix" })
  expect(within(fix).queryByRole("button", { name: /^(Skip|Unskip)$/ })).toBeNull()
})

test("SC36: an editor skips on the fix page, and the page says how long ago, the exact time on hover", async () => {
  const skippedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const method = input instanceof Request ? input.method : (init?.method ?? "GET")
    const body =
      method === "POST"
        ? { learning: { ...LEARNING, skippedAt } }
        : { learning: LEARNING, problems: PROBLEMS, canEdit: true }
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))
  })
  renderPage()
  const user = userEvent.setup()

  const fix = await screen.findByRole("region", { name: "The fix" })
  expect(within(fix).queryByText(/^Skipped /)).toBeNull()
  await user.click(within(fix).getByRole("button", { name: "Skip" }))

  expect(await within(fix).findByRole("button", { name: "Unskip" })).toBeInTheDocument()
  expect(within(fix).getByText(/^Skipped/)).toHaveTextContent("Skipped 2 hours ago")
  expect(within(fix).getByText("2 hours ago")).toHaveAttribute("title", absoluteTime(skippedAt))
})

test("Show messages opens the quoted message with the ones around it, on the page itself", async () => {
  const user = userEvent.setup()
  const fetched: string[] = []
  vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = String(input instanceof Request ? input.url : input)
    fetched.push(url)
    const body = url.includes("/messages")
      ? {
          messages: [
            { id: "msg-2", who: "user", track: "main", text: "run the tests", cited: false },
            { id: "msg-3", who: "assistant", track: "main", text: "waiting on jest", cited: true },
            {
              id: "msg-4",
              who: "Bash, failure",
              track: "main",
              text: "",
              input: "bun test",
              output: "1 failed",
              cited: false,
            },
          ],
        }
      : { learning: LEARNING, problems: PROBLEMS, canEdit: false }
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))
  })
  renderPage()

  const [first] = await screen.findAllByRole("button", { name: "Show messages" })
  await user.click(first as HTMLElement)

  const shown = await screen.findByRole("list", { name: "Messages around the quote" })
  expect(within(shown).getByText("run the tests")).toBeInTheDocument()
  expect(within(shown).getByText("bun test")).toBeInTheDocument()
  expect(within(shown).getByText("waiting on jest", { selector: "mark" })).toBeInTheDocument()
  expect(within(shown).getByText("waiting on jest").closest("li")).toHaveAttribute(
    "aria-current",
    "true",
  )
  expect(fetched.some((url) => url.includes("/api/learnings/l-1/messages?problem=1&quote=0"))).toBe(
    true,
  )
  await user.click(screen.getByRole("button", { name: "Hide messages" }))
  expect(screen.queryByRole("list", { name: "Messages around the quote" })).not.toBeInTheDocument()
})
