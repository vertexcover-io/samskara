import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Route, Routes } from "react-router-dom"
import { afterEach, expect, test, vi } from "vitest"
import { TestRouter } from "../tests/test-router.js"
import { LearnEventDetail, LearnEvents, messageText } from "./LearnEvents.js"

const FROM = "0b7e6c1a-4a1e-4c55-9c1e-2f3d5a6b7c8d"
const TO = "1c8f7d2b-5b2f-4d66-8d2f-3a4e6b7c8d9e"

const EVENT = {
  id: "e-1",
  eventId: "evt-1",
  sessionId: "sess-1",
  occurredAt: "2026-10-09T10:00:00.000Z",
  userLogin: "savitha",
  projectId: "p-1",
  projectName: "Shop",
  cwd: "/work/shop",
  skillVersion: "harness@1.33.1",
  trigger: "auto",
  whyTriggered: "User corrected error handling in a job twice",
  evidenceFromMessage: FROM,
  evidenceToMessage: TO,
  optionsShown: ["Rethrow caught errors", "Use the structured logger", "Report to Sentry"],
  proposedLearning: "Report to Sentry",
  optionUserPicked: "3",
  outcome: "new",
  status: "edited",
  finalLearning: "Report caught errors in jobs and webhooks to Sentry",
  rejectionReason: "",
  learningFile: "docs/learnings/report-caught-errors-to-sentry.md",
  replaces: null,
}

const message = (lineNumber: number, role: string, value: string) => ({
  id: `m-${lineNumber}`,
  lineNumber,
  role,
  msgType: "message",
  content: { type: "text", value },
})

const stubFetch = (routes: ReadonlyArray<{ match: string; body: unknown }>) => {
  const seen: string[] = []
  vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = new URL(input instanceof Request ? input.url : String(input), "http://x")
    const path = url.pathname + url.search
    seen.push(path)
    const route = routes.find((r) => path.includes(r.match))
    return Promise.resolve(
      route === undefined
        ? new Response(JSON.stringify({ error: "notFound" }), { status: 404 })
        : new Response(JSON.stringify(route.body), { status: 200 }),
    )
  })
  return seen
}

afterEach(() => {
  vi.restoreAllMocks()
})

test("the list shows the saved learning, who and where, and filters through the query", async () => {
  const seen = stubFetch([{ match: "/api/compound-learnings", body: { events: [EVENT] } }])
  render(
    <TestRouter initialEntries={["/learn-events"]}>
      <LearnEvents />
    </TestRouter>,
  )

  expect(
    await screen.findByText("Report caught errors in jobs and webhooks to Sentry"),
  ).toBeInTheDocument()
  expect(screen.getByText(/savitha · Shop · auto · harness@1.33.1/)).toBeInTheDocument()
  expect(screen.getByRole("link", { name: /Report caught errors/ })).toHaveAttribute(
    "href",
    "/learn-events/e-1",
  )

  await userEvent.selectOptions(screen.getByLabelText("outcome"), "rejected")

  await waitFor(() => expect(seen.at(-1)).toContain("outcome=rejected"))
})

test("the detail shows the options with the pick, and the conversation between the evidence ids", async () => {
  stubFetch([
    {
      match: "/api/compound-learnings/e-1",
      body: {
        event: EVENT,
        evidenceRange: { first: 4, last: 5 },
        truncated: true,
        evidence: [
          message(3, "user", "add retry to the email job"),
          message(4, "assistant", "I'll wrap it in try/catch with console.error"),
          message(5, "user", "No, errors go to Sentry"),
          message(6, "assistant", "Switched to captureException"),
        ],
      },
    },
  ])
  render(
    <TestRouter initialEntries={["/learn-events/e-1"]}>
      <Routes>
        <Route path="/learn-events/:id" element={<LearnEventDetail />} />
      </Routes>
    </TestRouter>,
  )

  expect(await screen.findByText(/Report to Sentry.*← picked/)).toBeInTheDocument()
  expect(screen.getByText("No, errors go to Sentry")).toBeInTheDocument()
  expect(screen.getByText("add retry to the email job").closest("li")).toHaveClass("opacity-60")
  expect(screen.getByText("No, errors go to Sentry").closest("li")).not.toHaveClass("opacity-60")
  expect(screen.getByRole("link", { name: /Open the full session/ })).toHaveAttribute(
    "href",
    "/sessions/sess-1?m=m-4",
  )
  expect(screen.getByText(/Showing the first 4 messages/)).toBeInTheDocument()
})

test("without access to the session's project there is no session link, and the reason is said", async () => {
  stubFetch([
    {
      match: "/api/compound-learnings/e-1",
      body: {
        event: { ...EVENT, projectId: null, projectName: null },
        evidenceRange: null,
        evidence: [],
        truncated: false,
      },
    },
  ])
  render(
    <TestRouter initialEntries={["/learn-events/e-1"]}>
      <Routes>
        <Route path="/learn-events/:id" element={<LearnEventDetail />} />
      </Routes>
    </TestRouter>,
  )

  expect(
    await screen.findByText("This session's transcript is not available to you yet."),
  ).toBeInTheDocument()
  expect(screen.queryByRole("link", { name: /Open the full session/ })).toBeNull()
})

test("a detail without message ids says the skill recorded none", async () => {
  const bare = { ...EVENT, evidenceFromMessage: null, evidenceToMessage: null }
  stubFetch([
    {
      match: "/api/compound-learnings/e-1",
      body: { event: bare, evidenceRange: null, evidence: [], truncated: false },
    },
  ])
  render(
    <TestRouter initialEntries={["/learn-events/e-1"]}>
      <Routes>
        <Route path="/learn-events/:id" element={<LearnEventDetail />} />
      </Routes>
    </TestRouter>,
  )

  expect(
    await screen.findByText("The skill did not record which messages this came from."),
  ).toBeInTheDocument()
})

test("a message that is not text shows its kind", () => {
  expect(messageText({ msgType: "tool", content: { type: "shell", command: "ls" } })).toBe(
    "[shell]",
  )
  expect(messageText({ msgType: "tool", content: null })).toBe("[tool]")
})
