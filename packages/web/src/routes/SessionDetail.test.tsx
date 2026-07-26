import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import type { SessionDetailPayload } from "../api/types.js"
import { buildPayload, message, text } from "../tests/session-fixtures.js"
import { TestRouter } from "../tests/test-router.js"
import { SessionDetail } from "./SessionDetail.js"

const PAYLOAD: SessionDetailPayload = buildPayload({
  subagents: [
    {
      agentId: "a1",
      agentType: "db-schema-auditor",
      description: "Audit keys",
      parentAgentId: null,
    },
  ],
  messages: [
    message({
      lineNumber: 1,
      msgType: "message",
      role: "user",
      content: text("Make it idempotent"),
    }),
    message({
      lineNumber: 2,
      msgType: "message",
      role: "assistant",
      content: [
        { type: "thinking", thinking: "No unique constraint exists yet" },
        { type: "text", text: "Here is the plan for the upsert" },
      ],
    }),
    message({ id: "tool-msg", lineNumber: 3, msgType: "toolCall" }),
    message({ lineNumber: 4, msgType: "turnEvent", subType: "agentSpawn", agentId: "a1" }),
    message({
      lineNumber: 5,
      msgType: "message",
      role: "assistant",
      agentId: "a1",
      isSubagent: true,
      content: text("Branch found the missing constraint"),
    }),
    message({ lineNumber: 6, msgType: "turnEvent", subType: "agentReturn", agentId: "a1" }),
    message({
      lineNumber: 7,
      msgType: "fileEvent",
      details: { type: "artifact", path: "migrations/0007.sql", title: "Migration" },
    }),
  ],
  toolCalls: [
    {
      toolId: "t-1",
      messageId: "tool-msg",
      toolName: "Grep",
      toolInput: { pattern: "INSERT INTO" },
      result: { matches: 3 },
      status: "success",
    },
  ],
})

const renderDetail = (payload: SessionDetailPayload = PAYLOAD) => {
  vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = typeof input === "string" ? input : String(input)
    if (url.includes("/api/sessions/")) {
      return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }))
    }
    return Promise.resolve(new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }))
  })

  return render(
    <TestRouter initialEntries={["/sessions/s-1"]}>
      <Routes>
        <Route path="/sessions/:sessionId" element={<SessionDetail />} />
      </Routes>
    </TestRouter>,
  )
}

const tabs = () => screen.getAllByRole("tab")

const panelOf = () => screen.getByRole("tabpanel")

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

test("S37: the detail route renders exactly three tabs - Conversation, Tool Calls, Artifacts - with Conversation selected on load", async () => {
  renderDetail()

  await waitFor(() => expect(tabs()).toHaveLength(3))

  expect(tabs().map((tab) => tab.textContent)).toEqual([
    expect.stringContaining("Conversation"),
    expect.stringContaining("Tool Calls"),
    expect.stringContaining("Artifacts"),
  ])
  expect(screen.getByRole("tab", { name: /Conversation/ })).toHaveAttribute("aria-selected", "true")
  expect(screen.getByRole("tab", { name: /Tool Calls/ })).toHaveAttribute("aria-selected", "false")
})

test("S38: Conversation hides tool payloads until the inline-tools checkbox is ticked", async () => {
  const user = userEvent.setup()
  renderDetail()

  await waitFor(() => expect(tabs()).toHaveLength(3))

  const panel = screen.getByRole("tabpanel")
  expect(within(panel).getByText(/Make it idempotent/)).toBeInTheDocument()
  expect(within(panel).getByText(/Here is the plan for the upsert/)).toBeInTheDocument()
  expect(within(panel).queryByRole("button", { name: /Grep/ })).not.toBeInTheDocument()

  await user.click(screen.getByRole("checkbox", { name: /show tool calls inline/i }))

  expect(
    within(screen.getByRole("tabpanel")).getByRole("button", { name: /Grep/ }),
  ).toBeInTheDocument()
})

test("S37: thinking is present but collapsed on Conversation, so the prose leads and the reasoning is opt-in", async () => {
  renderDetail()

  await waitFor(() => expect(tabs()).toHaveLength(3))

  const summary = screen.getByText(/^Thinking$/)
  const thinking = summary.closest("details")
  expect(thinking).not.toBeNull()
  expect(thinking).not.toHaveAttribute("open")
  expect(within(panelOf()).getByText(/No unique constraint exists yet/)).toBeInTheDocument()
})

test("S37: ArrowRight, End, and Home move the selected tab under a roving tabindex, keeping exactly one tab reachable by Tab", async () => {
  const user = userEvent.setup()
  renderDetail()

  await waitFor(() => expect(tabs()).toHaveLength(3))

  const [conversation, toolCalls, artifacts] = tabs()
  conversation?.focus()

  await user.keyboard("{ArrowRight}")
  expect(toolCalls).toHaveAttribute("aria-selected", "true")
  expect(document.activeElement).toBe(toolCalls)
  expect(conversation).toHaveAttribute("tabindex", "-1")
  expect(toolCalls).toHaveAttribute("tabindex", "0")

  await user.keyboard("{End}")
  expect(artifacts).toHaveAttribute("aria-selected", "true")

  await user.keyboard("{Home}")
  expect(conversation).toHaveAttribute("aria-selected", "true")

  await user.keyboard("{ArrowLeft}")
  expect(artifacts).toHaveAttribute("aria-selected", "true")
})

test("S37: the masthead reports all six session facts from the payload", async () => {
  renderDetail()

  await waitFor(() => expect(tabs()).toHaveLength(3))

  const facts = screen.getByRole("group", { name: /session facts/i })
  for (const label of [
    "Duration",
    "Messages",
    "Tool calls",
    "Subagents",
    "Tokens in",
    "Tokens out",
  ]) {
    expect(within(facts).getByText(label)).toBeInTheDocument()
  }
  expect(within(facts).getByText("214,600")).toBeInTheDocument()
  expect(within(facts).getByText("18,200")).toBeInTheDocument()
})

test("EDGE-008: a 404 from the detail endpoint renders a not-found state with a way back, not a blank panel", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ error: "sessionNotFound" }), { status: 404 }),
  )

  render(
    <TestRouter initialEntries={["/sessions/ghost"]}>
      <Routes>
        <Route path="/sessions/:sessionId" element={<SessionDetail />} />
      </Routes>
    </TestRouter>,
  )

  expect(await screen.findByText(/no such session/i)).toBeInTheDocument()
  expect(screen.getByRole("button", { name: /back to all sessions/i })).toBeInTheDocument()
  expect(screen.queryByRole("tab")).not.toBeInTheDocument()
})
