import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import type { SessionDetailPayload } from "../api/types.js"
import { buildPayload, message, pastedImage, text } from "../tests/session-fixtures.js"
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

const BRANCH_PAYLOAD: SessionDetailPayload = buildPayload({
  subagents: [
    { agentId: "a1", agentType: "auditor", description: "Audit keys", parentAgentId: null },
  ],
  messages: [
    message({ lineNumber: 1, msgType: "turnEvent", subType: "agentSpawn", agentId: "a1" }),
    message({ lineNumber: 2, msgType: "systemEvent", agentId: "a1", isSubagent: true }),
    message({
      id: "branch-say",
      lineNumber: 3,
      msgType: "message",
      role: "assistant",
      agentId: "a1",
      isSubagent: true,
      content: text("Checked the three tables"),
    }),
    message({
      id: "branch-then",
      lineNumber: 4,
      msgType: "message",
      role: "assistant",
      agentId: "a1",
      isSubagent: true,
      content: text("No unique constraints anywhere"),
    }),
  ],
})

const agentCall = (messageId: string, toolId: string) => ({
  toolId,
  messageId,
  toolName: "Agent",
  toolInput: { description: "go" },
  result: null,
  status: "success",
})

const NESTED_PAYLOAD: SessionDetailPayload = buildPayload({
  subagents: [
    { agentId: "a1", agentType: "explorer", description: "Top task", parentAgentId: null },
    { agentId: "a2", agentType: "researcher", description: "Nested task", parentAgentId: "a1" },
  ],
  messages: [
    message({ id: "top-call", lineNumber: 1, msgType: "toolCall" }),
    message({
      id: "nested-call",
      lineNumber: 2,
      msgType: "toolCall",
      agentId: "a1",
      isSubagent: true,
    }),
    message({
      id: "nested-say",
      lineNumber: 3,
      msgType: "message",
      role: "assistant",
      agentId: "a2",
      isSubagent: true,
      content: text("Nested branch findings"),
    }),
  ],
  toolCalls: [agentCall("top-call", "t-top"), agentCall("nested-call", "t-nested")],
})

type ArtifactsReply = { readonly status: number; readonly body: unknown }

const OK_EMPTY: ArtifactsReply = { status: 200, body: { artifacts: [] } }

const renderDetail = (
  payload: SessionDetailPayload = PAYLOAD,
  artifacts: ArtifactsReply = OK_EMPTY,
  entry = "/sessions/s-1",
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
    <TestRouter initialEntries={[entry]}>
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

test("a screenshot pasted with a prompt renders as an image inside that prompt, not as its base64", async () => {
  const png = "iVBORw0KGgoAAAANSUhEUg=="
  renderDetail(
    buildPayload({
      messages: [
        message({
          lineNumber: 9,
          msgType: "message",
          role: "user",
          content: { type: "text", value: "Remove the model chip" },
        }),
        message({
          lineNumber: 9,
          msgType: "message",
          role: "user",
          content: pastedImage(png),
        }),
      ],
    }),
  )

  await waitFor(() => expect(tabs()).toHaveLength(3))

  const panel = panelOf()
  const prompt = within(panel)
    .getByText(/Remove the model chip/)
    .closest("article")
  expect(prompt).not.toBeNull()
  expect(within(prompt as HTMLElement).getByRole("img")).toHaveAttribute(
    "src",
    `data:image/png;base64,${png}`,
  )
  expect(panel.textContent).not.toContain(png)
})

test("the slash command that opened a session is on Conversation, spec and all", async () => {
  renderDetail(
    buildPayload({
      messages: [
        message({
          lineNumber: 1,
          msgType: "localCommand",
          details: {
            command: "/harness:orchestrate",
            commandType: "slash",
            args: "Capture files the agent caused to be written",
          },
        }),
        message({
          lineNumber: 2,
          msgType: "message",
          role: "assistant",
          content: text("I'll start the pipeline"),
        }),
      ],
    }),
  )

  await waitFor(() => expect(tabs()).toHaveLength(3))

  const panel = panelOf()
  expect(within(panel).getByText("/harness:orchestrate")).toBeInTheDocument()
  expect(
    within(panel).getByText(/Capture files the agent caused to be written/),
  ).toBeInTheDocument()
})

test("a block whose thinking was encrypted shows what it did, not a claim that its text went missing", async () => {
  renderDetail(
    buildPayload({
      messages: [
        message({
          lineNumber: 1,
          msgType: "message",
          role: "assistant",
          content: { type: "reasoning", value: "", signature: "sig" },
        }),
      ],
    }),
  )

  await waitFor(() => expect(tabs()).toHaveLength(3))

  const panel = panelOf()
  expect(within(panel).getByText("Claude")).toBeInTheDocument()
  expect(panel.textContent).not.toContain("No text was captured")
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

const metaLineOf = async (): Promise<string> => {
  await screen.findByRole("heading", { name: "Make ingest idempotent" })
  // The title is pinned in its own bar now, so the meta line is found from the facts it sits above.
  const masthead = screen.getByRole("group", { name: /session facts/i }).parentElement
  const line = masthead?.querySelector("p")
  return (line?.textContent ?? "").replace(/\s+/g, " ").trim()
}

test("S37: the masthead names the repo the session ran in, alongside project and user", async () => {
  const repo = { host: "github.com", owner: "acme", repoName: "samskara" }
  renderDetail(buildPayload({ ...PAYLOAD, session: { repo } }))

  expect(await metaLineOf()).toBe("Samskara·ritesh·acme/samskara")
})

test("S37: a remote-backed repo links out to the repo itself, on its own host", async () => {
  const repo = { host: "gitlab.example.com", owner: "acme", repoName: "samskara" }
  renderDetail(buildPayload({ ...PAYLOAD, session: { repo } }))

  const link = await screen.findByRole("link", { name: "acme/samskara" })
  expect(link).toHaveAttribute("href", "https://gitlab.example.com/acme/samskara")
  expect(link).toHaveAttribute("rel", expect.stringContaining("noreferrer"))
})

test("S37: a remoteless repo is named but not linked - there is no url to send a reader to", async () => {
  const repo = { host: "local", owner: "/Users/maya/Projects/samskara", repoName: "samskara" }
  renderDetail(buildPayload({ ...PAYLOAD, session: { repo } }))

  expect(await metaLineOf()).toBe("Samskara·ritesh·samskara")
  expect(screen.queryByRole("link", { name: "samskara" })).toBeNull()
})

test("S37: a session with no repo ends the masthead at the user - no dangling separator", async () => {
  renderDetail(buildPayload({ ...PAYLOAD, session: { repo: null } }))

  expect(await metaLineOf()).toBe("Samskara·ritesh")
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

test("S63: a branch reads like the main spine - its system events are dropped and its two assistant turns merge into a single block", async () => {
  const user = userEvent.setup()
  renderDetail(BRANCH_PAYLOAD)

  await waitFor(() => expect(tabs()).toHaveLength(3))
  await user.click(screen.getByRole("button", { name: /open branch/i }))

  const branch = screen.getByRole("region", { name: /auditor conversation/i })
  expect(within(branch).queryByText(/systemEvent/)).not.toBeInTheDocument()
  expect(within(branch).getAllByRole("listitem")).toHaveLength(1)
  expect(within(branch).getByText(/Checked the three tables/)).toBeInTheDocument()
  expect(within(branch).getByText(/No unique constraints anywhere/)).toBeInTheDocument()
})

test("S64: copying a record's link yields a URL naming that message and the branch holding it, so a reader lands on it rather than at the top of the transcript", async () => {
  const user = userEvent.setup()
  renderDetail(BRANCH_PAYLOAD)

  await waitFor(() => expect(tabs()).toHaveLength(3))
  await user.click(screen.getByRole("button", { name: /open branch/i }))

  const branch = screen.getByRole("region", { name: /auditor conversation/i })
  await user.click(within(branch).getByRole("button", { name: /copy link to this message/i }))

  expect(await navigator.clipboard.readText()).toBe(
    `${window.location.origin}/sessions/s-1?agent=a1&m=branch-say`,
  )
})

test("S65: a link to a message inside a branch opens that branch on arrival, so the shared line is on screen rather than folded away", async () => {
  renderDetail(BRANCH_PAYLOAD, OK_EMPTY, "/sessions/s-1?m=branch-say")

  await waitFor(() => expect(tabs()).toHaveLength(3))

  const branch = await screen.findByRole("region", { name: /auditor conversation/i })
  expect(within(branch).getByText(/Checked the three tables/)).toBeInTheDocument()
})

test("S66: a link naming a message this transcript does not hold is ignored, leaving the session reading as it would without one", async () => {
  renderDetail(BRANCH_PAYLOAD, OK_EMPTY, "/sessions/s-1?m=not-in-this-session")

  await waitFor(() => expect(tabs()).toHaveLength(3))

  expect(screen.queryByText(/not part of this session/i)).not.toBeInTheDocument()
  expect(within(panelOf()).getByRole("button", { name: /open branch/i })).toBeInTheDocument()
})

test("S67: the linked record inside a branch is marked as the reader's location, so the shared line is identifiable among its neighbours", async () => {
  renderDetail(BRANCH_PAYLOAD, OK_EMPTY, "/sessions/s-1?m=branch-say")

  await waitFor(() => expect(tabs()).toHaveLength(3))

  const branch = await screen.findByRole("region", { name: /auditor conversation/i })
  const marked = within(branch)
    .getByText(/Checked the three tables/)
    .closest("article")
  expect(marked).toHaveAttribute("aria-current", "location")
})

test("S68: a session with no branches marks its linked record too - the mark is not something only the rail layout gets", async () => {
  const solo = buildPayload({
    messages: [
      message({ lineNumber: 1, msgType: "message", role: "user", content: text("Only prompt") }),
      message({
        id: "solo-say",
        lineNumber: 2,
        msgType: "message",
        role: "assistant",
        content: text("Only answer"),
      }),
    ],
  })
  renderDetail(solo, OK_EMPTY, "/sessions/s-1?m=solo-say")

  await waitFor(() => expect(tabs()).toHaveLength(3))

  expect(screen.getByText(/Only answer/).closest("article")).toHaveAttribute(
    "aria-current",
    "location",
  )
  expect(screen.getByText(/Only prompt/).closest("article")).not.toHaveAttribute("aria-current")
})

test("S69: opening a branch records it in the query, so the branch a reader is looking at is itself shareable", async () => {
  const user = userEvent.setup()
  renderDetail(BRANCH_PAYLOAD)

  await waitFor(() => expect(tabs()).toHaveLength(3))
  await user.click(screen.getByRole("button", { name: /open branch/i }))

  expect(screen.getByTestId("location")).toHaveTextContent("/sessions/s-1?agent=a1")
})

test("S70: closing a branch drops it from the query rather than leaving a link that reopens it", async () => {
  const user = userEvent.setup()
  renderDetail(BRANCH_PAYLOAD, OK_EMPTY, "/sessions/s-1?agent=a1")

  await waitFor(() => expect(tabs()).toHaveLength(3))
  await user.click(await screen.findByRole("button", { name: /close branch/i }))

  expect(screen.getByTestId("location")).not.toHaveTextContent("agent=a1")
})

test("S71: arriving on a shared branch link opens that branch, so its records and their own links are reachable at once", async () => {
  renderDetail(BRANCH_PAYLOAD, OK_EMPTY, "/sessions/s-1?agent=a1")

  await waitFor(() => expect(tabs()).toHaveLength(3))

  const branch = await screen.findByRole("region", { name: /auditor conversation/i })
  expect(within(branch).getByText(/Checked the three tables/)).toBeInTheDocument()
  expect(
    within(branch).getAllByRole("button", { name: /copy link to this message/i }).length,
  ).toBeGreaterThan(0)
})

type Scroll = { readonly id: string; readonly block: string | undefined }

const recordScrolls = (): ReadonlyArray<Scroll> => {
  const seen: Array<Scroll> = []
  vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (
    this: Element,
    options?: boolean | ScrollIntoViewOptions,
  ) {
    seen.push({ id: this.id, block: typeof options === "object" ? options.block : undefined })
  })
  return seen
}

// An open annex lives inside its spawn record, so that record runs the height of the whole
// branch. Centring it lands thousands of pixels past the marker the reader asked for.
test("S72: arriving on a shared branch link lands on that branch's spawn point, not centred somewhere inside the branch", async () => {
  const scrolled = recordScrolls()

  renderDetail(BRANCH_PAYLOAD, OK_EMPTY, "/sessions/s-1?agent=a1")

  await waitFor(() => expect(tabs()).toHaveLength(3))
  await waitFor(() => expect(scrolled).toContainEqual({ id: "spawn-a1", block: "start" }))
})

test("S73: a message permalink lands on the top of the record it names, so a tall merged block does not scroll past its own beginning", async () => {
  const scrolled = recordScrolls()

  renderDetail(BRANCH_PAYLOAD, OK_EMPTY, "/sessions/s-1?agent=a1&m=branch-say")

  await waitFor(() => expect(tabs()).toHaveLength(3))
  await waitFor(() => expect(scrolled).toContainEqual({ id: "r-branch-say", block: "start" }))
})

// Most branches share one agentType, so the type alone renders a column of identical rows. The
// description is the task the branch was given, which is what actually tells them apart.
test("S74: the rail names each branch by the task it was given, keeping its type as the secondary label", async () => {
  renderDetail(BRANCH_PAYLOAD)

  await waitFor(() => expect(tabs()).toHaveLength(3))

  const rail = screen.getByRole("complementary", { name: /agents in this session/i })
  const branch = within(rail).getByRole("button", { name: /audit keys/i })
  expect(branch).toHaveTextContent("Audit keys")
  expect(branch).toHaveTextContent("auditor")
})

test("S75: the rail reports no run status, so a branch is never labelled interrupted on evidence the capture does not have", async () => {
  renderDetail(BRANCH_PAYLOAD)

  await waitFor(() => expect(tabs()).toHaveLength(3))

  const rail = screen.getByRole("complementary", { name: /agents in this session/i })
  expect(within(rail).queryByText(/interrupted/i)).not.toBeInTheDocument()
  expect(within(rail).queryByText(/^done$/i)).not.toBeInTheDocument()
})

// A subagent can spawn its own subagents. Its annex is nested inside the parent's, so reaching it
// means opening the whole ancestry, not just the branch that was named.
test("S77: a link to a nested branch opens the parent branch holding it, so a subagent spawned by a subagent is reachable", async () => {
  renderDetail(NESTED_PAYLOAD, OK_EMPTY, "/sessions/s-1?agent=a2")

  await waitFor(() => expect(tabs()).toHaveLength(3))

  const nested = await screen.findByRole("region", { name: /researcher conversation/i })
  expect(within(nested).getByText(/Nested branch findings/)).toBeInTheDocument()
})

test("S78: the rail opens a nested branch too, so every agent it lists leads somewhere", async () => {
  const user = userEvent.setup()
  renderDetail(NESTED_PAYLOAD)

  await waitFor(() => expect(tabs()).toHaveLength(3))

  const rail = screen.getByRole("complementary", { name: /agents in this session/i })
  await user.click(within(rail).getByRole("button", { name: /nested task/i }))

  const nested = await screen.findByRole("region", { name: /researcher conversation/i })
  expect(within(nested).getByText(/Nested branch findings/)).toBeInTheDocument()
})

test("a skill body injected under the user's role is credited to the skill and folded away, not printed as a prompt", async () => {
  const skill = `Base directory for this skill: /Users/maya/skills/orchestrate\n\n${"# Orchestrate\n".repeat(200)}`
  renderDetail(
    buildPayload({
      messages: [
        message({
          lineNumber: 1,
          msgType: "message",
          role: "user",
          content: text("Run the pipeline"),
        }),
        message({
          lineNumber: 2,
          msgType: "message",
          role: "user",
          subType: "toolInjection",
          content: text(skill),
        }),
      ],
    }),
  )

  await waitFor(() => expect(tabs()).toHaveLength(3))

  const panel = panelOf()
  const injected = within(panel).getByText("Skill Loaded — orchestrate").closest("article")
  expect(injected).not.toBeNull()

  // The skill stands where the speaker's name goes, so nothing claims the user said this.
  const shown = injected as HTMLElement
  expect(within(shown).queryByText("ritesh")).toBeNull()
  // Present but folded: the reader opts into 3 KB of skill body rather than scrolling past it.
  expect(shown.querySelector("details")).not.toHaveAttribute("open")

  expect(within(panel).getByText(/Run the pipeline/)).toBeInTheDocument()
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
