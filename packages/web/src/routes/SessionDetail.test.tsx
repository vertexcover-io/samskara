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

type ArtifactsReply = { readonly status: number; readonly body: unknown }

const OK_EMPTY: ArtifactsReply = { status: 200, body: { artifacts: [] } }

const renderDetail = (
  payload: SessionDetailPayload = PAYLOAD,
  artifacts: ArtifactsReply = OK_EMPTY,
) => {
  vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = typeof input === "string" ? input : String(input)
    if (url.includes("/artifacts")) {
      return Promise.resolve(
        new Response(JSON.stringify(artifacts.body), { status: artifacts.status }),
      )
    }
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

const CAPTURED = {
  id: "cap-1",
  path: "/work/acme/docs/notes.md",
  relativePath: "docs/notes.md",
  mimeType: "text/markdown",
  isBinary: false,
  changeKind: "edited",
  diff: "@@ -1,3 +1,3 @@\n-The original line.\n+The replacement line.\n",
  editCount: 1,
  byteSize: 42,
  hasBase: true,
  firstSeenAt: "2026-07-01T10:00:00.000Z",
  lastSeenAt: "2026-07-01T10:05:00.000Z",
}

test("S48: the artifacts tab lists the session's captured files as a folder tree and shows the selected one's diff", async () => {
  const user = userEvent.setup()
  renderDetail(PAYLOAD, {
    status: 200,
    body: {
      artifacts: [
        CAPTURED,
        { ...CAPTURED, id: "cap-2", relativePath: "src/ingest.ts", diff: null },
      ],
    },
  })

  await waitFor(() => expect(tabs()).toHaveLength(3))
  await user.click(screen.getByRole("tab", { name: /Artifacts/ }))

  const list = await screen.findByRole("list", { name: /filed artifacts/i })
  // The browser nests files under folder rows, so the path is carried by the tree, not the leaf.
  expect(within(list).getByRole("button", { name: /^docs$/ })).toBeInTheDocument()
  expect(within(list).getByRole("button", { name: /^src$/ })).toBeInTheDocument()
  expect(within(list).getByRole("button", { name: /notes\.md/ })).toBeInTheDocument()
  expect(within(list).getByRole("button", { name: /ingest\.ts/ })).toBeInTheDocument()

  const viewer = screen.getByRole("region", { name: /artifact viewer/i })
  expect(within(viewer).getByText("-The original line.")).toBeInTheDocument()
  expect(within(viewer).getByText("+The replacement line.")).toBeInTheDocument()
})

test("S49: a session with no captured artifacts reads empty rather than showing demo fixtures", async () => {
  const user = userEvent.setup()
  renderDetail(buildPayload({ messages: [message({ lineNumber: 1, msgType: "message" })] }))

  await waitFor(() => expect(tabs()).toHaveLength(3))
  await user.click(screen.getByRole("tab", { name: /Artifacts/ }))

  expect(await screen.findByText(/no artifacts were filed/i)).toBeInTheDocument()

  for (const fixture of ["architecture.svg", "walkthrough.mp4", "idempotent-ingest.md"]) {
    expect(document.body.textContent).not.toContain(fixture)
  }
  expect(screen.getByRole("tab", { name: /Artifacts/ })).toHaveTextContent("0")
})

test("S53: a transcript frame-link artifact still renders when the captured-artifact list is empty", async () => {
  const user = userEvent.setup()
  renderDetail()

  await waitFor(() => expect(tabs()).toHaveLength(3))
  await user.click(screen.getByRole("tab", { name: /Artifacts/ }))

  const list = await screen.findByRole("list", { name: /filed artifacts/i })
  expect(within(list).getByRole("button", { name: /0007\.sql/ })).toBeInTheDocument()

  const viewer = screen.getByRole("region", { name: /artifact viewer/i })
  expect(within(viewer).getByText("migrations/0007.sql")).toBeInTheDocument()
})

test("S54: a failed artifact fetch leaves the other tabs working and shows a failure notice, not a blank pane", async () => {
  const user = userEvent.setup()
  renderDetail(PAYLOAD, { status: 500, body: { error: "boom" } })

  await waitFor(() => expect(tabs()).toHaveLength(3))

  expect(within(panelOf()).getByText(/Make it idempotent/)).toBeInTheDocument()

  await user.click(screen.getByRole("tab", { name: /Tool Calls/ }))
  expect(within(panelOf()).getAllByRole("button", { name: /Grep/ }).length).toBeGreaterThan(0)

  await user.click(screen.getByRole("tab", { name: /Artifacts/ }))
  const notice = await screen.findByText(/captured artifacts could not be retrieved/i)
  expect(notice).toBeInTheDocument()
})

test("S54: a 200 whose artifact rows are malformed is refused at the parse boundary rather than rendered as partial data", async () => {
  const user = userEvent.setup()
  // A row missing `relativePath` and `mimeType` -- the shape a schema drift would produce.
  renderDetail(PAYLOAD, {
    status: 200,
    body: { artifacts: [{ id: "cap-1", path: "/work/acme/docs/notes.md" }] },
  })

  await waitFor(() => expect(tabs()).toHaveLength(3))
  await user.click(screen.getByRole("tab", { name: /Artifacts/ }))

  expect(await screen.findByText(/captured artifacts could not be retrieved/i)).toBeInTheDocument()
  // Nothing from the malformed payload leaks through; the transcript's own frame-link is
  // unaffected, so the count reflects it alone.
  expect(screen.queryByText("docs/notes.md")).not.toBeInTheDocument()
  expect(screen.getByRole("tab", { name: /Artifacts/ })).toHaveTextContent("1")
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
