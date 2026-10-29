import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import { Link, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import type { SessionDetailPayload } from "../api/types.js"
import {
  buildPayload,
  commit,
  facts,
  message,
  pastedImage,
  pullRequest,
  text,
} from "../tests/session-fixtures.js"
import { TestRouter } from "../tests/test-router.js"
import { SessionDetail, verdictSentence } from "./SessionDetail.js"

const PAYLOAD: SessionDetailPayload = buildPayload({
  subagents: [
    {
      agentId: "a1",
      agentType: "db-schema-auditor",
      description: "Audit keys",
      parentAgentId: null,
      spawnToolUseId: null,
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

test("Codex capture labels the actor and leaves missing usage unavailable", async () => {
  renderDetail(
    buildPayload({
      session: { ...facts(), source: "codex", modelSnapshot: "gpt-5.4" },
      tokenUsageAvailable: false,
      messages: [message({ role: "assistant", content: text("Captured from Codex") })],
    }),
  )
  await tabsLoaded()
  expect(within(panelOf()).getByText("Codex")).toBeInTheDocument()
  expect(within(panelOf()).queryByText("Claude")).not.toBeInTheDocument()
  const factsPanel = screen.getByRole("group", { name: "Session facts" })
  expect(factsPanel.textContent).toContain("Model snapshotgpt-5.4")
  expect(factsPanel.textContent).toContain("Tokens inunavailable")
})

const BRANCH_PAYLOAD: SessionDetailPayload = buildPayload({
  subagents: [
    {
      agentId: "a1",
      agentType: "auditor",
      description: "Audit keys",
      parentAgentId: null,
      spawnToolUseId: null,
    },
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
    {
      agentId: "a1",
      agentType: "explorer",
      description: "Top task",
      parentAgentId: null,
      spawnToolUseId: null,
    },
    {
      agentId: "a2",
      agentType: "researcher",
      description: "Nested task",
      parentAgentId: "a1",
      spawnToolUseId: null,
    },
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

type Reply = { readonly status: number; readonly body: unknown }

const OK_EMPTY: Reply = { status: 200, body: { artifacts: [] } }

/** What GET /api/reviewer-options answers: both harnesses installed, env defaults preselected. */
const REVIEWER_OPTIONS: Reply = {
  status: 200,
  body: {
    defaultHarness: "opencode",
    defaultModel: "zai-coding-plan/glm-5.3-flash",
    harnesses: [
      {
        harness: "opencode",
        defaultModel: "zai-coding-plan/glm-5.3-flash",
        available: true,
        models: ["zai-coding-plan/glm-5.3-flash"],
      },
      {
        harness: "claude",
        defaultModel: "sonnet",
        available: true,
        models: ["sonnet", "opus", "haiku"],
      },
    ],
  },
}

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status })

// The tag editor probes this on every mount regardless of what a test is asserting, so both
// render helpers answer it unconditionally rather than making every test's fetch impl handle it.
const filtersResponse = (): Response =>
  jsonResponse(200, { projects: [], authors: [], repositories: [], branches: [], tags: [] })

const renderDetail = (
  payload: SessionDetailPayload = PAYLOAD,
  artifacts: Reply = OK_EMPTY,
  entry = "/sessions/s-1",
  extras: {
    readonly review?: Reply
    readonly analyze?: Reply
    /** A reply sequence for GET /analyze/:jobId (job status), consumed in order. */
    readonly analyzeJob?: Reply | ReadonlyArray<Reply>
    /** A reply sequence for GET /aireview, consumed in order; an empty queue stays 404. */
    readonly aireview?: Reply | ReadonlyArray<Reply>
    /** What GET /review answers once an aireview reply landed 200: analyze writes the AI review row. */
    readonly reviewAfterAi?: Reply
    readonly reviewerOptions?: Reply
    /** Rendered inside the router beside the page, so a test can navigate without remounting it. */
    readonly beside?: ReactNode
  } = {},
) => {
  const review = extras.review ?? { status: 200, body: { reviews: [] } }
  const analyze = extras.analyze ?? { status: 202, body: { jobId: "job-1" } }
  const analyzeJobQueue: ReadonlyArray<Reply> =
    extras.analyzeJob === undefined
      ? [
          {
            status: 200,
            body: {
              job: {
                status: "running",
                jobId: "job-1",
                startedAt: "2026-08-30T10:00:00Z",
                lastEvent: null,
              },
            },
          },
        ]
      : Array.isArray(extras.analyzeJob)
        ? [...extras.analyzeJob]
        : [extras.analyzeJob]
  const aireviewQueue =
    extras.aireview === undefined
      ? []
      : Array.isArray(extras.aireview)
        ? [...extras.aireview]
        : [extras.aireview]
  let aireviewCalls = 0
  let analyzeJobCalls = 0
  let aiLanded = false
  // Every POST /analyze body, in order — the modal-choice test asserts what the dialog sent.
  const analyzeBodies: unknown[] = []
  // A 409 analysisAlreadyExists means the verdict landed out-of-band (e.g. a stale tab), so
  // the refreshed review list must include it even though no aireview reply ever said 200.
  let existsConflict = false
  const respond = (reply: Reply): Promise<Response> =>
    Promise.resolve(new Response(JSON.stringify(reply.body), { status: reply.status }))
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = typeof input === "string" ? input : String(input)
    if (url.includes("/api/sessions/filters")) return Promise.resolve(filtersResponse())
    // Job status comes as GET /analyze/:jobId — before the POST /analyze branch, whose
    // substring would swallow it. A succeeded job is what lands the AI row in the refreshed
    // review list.
    if (url.includes("/analyze/")) {
      const reply =
        analyzeJobQueue[Math.min(analyzeJobCalls, analyzeJobQueue.length - 1)] ??
        ({ status: 404, body: { error: "jobNotFound" } } as Reply)
      analyzeJobCalls += 1
      const job = (reply.body as { job?: { status?: string } }).job
      if (job?.status === "succeeded") aiLanded = true
      return respond(reply)
    }
    if (url.includes("/analyze")) {
      if (typeof init?.body === "string") analyzeBodies.push(JSON.parse(init.body))
      if (
        typeof analyze.body === "object" &&
        analyze.body !== null &&
        (analyze.body as { error?: string }).error === "analysisAlreadyExists"
      )
        existsConflict = true
      return respond(analyze)
    }
    if (url.includes("/aireview")) {
      const reply =
        aireviewQueue[Math.min(aireviewCalls, aireviewQueue.length - 1)] ??
        ({ status: 404, body: { error: "noAiReview" } } as Reply)
      aireviewCalls += 1
      if (reply.status === 200) aiLanded = true
      return respond(reply)
    }
    if (url.includes("/artifacts")) {
      return respond(artifacts)
    }
    // Before the /review branch: "/reviewer-options" contains "/review" as a substring.
    if (url.includes("/reviewer-options")) {
      return respond(extras.reviewerOptions ?? REVIEWER_OPTIONS)
    }
    if (url.includes("/review")) {
      const after = aiLanded || existsConflict ? extras.reviewAfterAi : undefined
      return respond(after ?? review)
    }
    if (url.includes("/api/sessions/")) {
      return respond({ status: 200, body: payload })
    }
    return respond({ status: 401, body: { error: "unauthorized" } })
  })

  return {
    ...render(
      <TestRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/sessions/:sessionId" element={<SessionDetail />} />
        </Routes>
        {extras.beside}
      </TestRouter>,
    ),
    analyzeBodies,
  }
}

type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const isPatch = (init: RequestInit | undefined): boolean => init?.method === "PATCH"

/**
 * The detail view always loads the review tab's review list, so a test that only cares about
 * the header still has to answer them. Handled here rather than in every caller: these tests
 * assert on renaming, and an empty review list is the uninteresting case for all of them.
 */
const renderDetailWithFetch = (impl: FetchImpl, entry = "/sessions/s-1") => {
  const withReviewLists: FetchImpl = (input, init) => {
    const url = typeof input === "string" ? input : String(input)
    if (url.includes("/api/sessions/filters")) return Promise.resolve(filtersResponse())
    if (url.includes("/review") && !isPatch(init)) {
      return Promise.resolve(jsonResponse(200, { reviews: [] }))
    }
    return impl(input, init)
  }
  vi.spyOn(globalThis, "fetch").mockImplementation(withReviewLists)
  return render(
    <TestRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/sessions/:sessionId" element={<SessionDetail />} />
      </Routes>
    </TestRouter>,
  )
}

const tabs = () => screen.getAllByRole("tab")

const tabsLoaded = () => waitFor(() => expect(tabs()).toHaveLength(6))

const panelOf = () => screen.getByRole("tabpanel")

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

test("S37: the detail route renders one tab per view, with Conversation selected on load", async () => {
  renderDetail()

  await tabsLoaded()

  expect(tabs().map((tab) => tab.textContent)).toEqual([
    expect.stringContaining("Conversation"),
    expect.stringContaining("Tool Calls"),
    expect.stringContaining("Artifacts"),
    expect.stringContaining("Commits"),
    expect.stringContaining("Pull Requests"),
    expect.stringContaining("Review"),
  ])
  expect(screen.getByRole("tab", { name: /Conversation/ })).toHaveAttribute("aria-selected", "true")
  expect(screen.getByRole("tab", { name: /Tool Calls/ })).toHaveAttribute("aria-selected", "false")
})

test("S38: Conversation hides tool payloads until the inline-tools checkbox is ticked", async () => {
  const user = userEvent.setup()
  renderDetail()

  await tabsLoaded()

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

  await tabsLoaded()

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

  await tabsLoaded()

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

  await tabsLoaded()

  const panel = panelOf()
  expect(within(panel).getByText("Claude")).toBeInTheDocument()
  expect(panel.textContent).not.toContain("No text was captured")
})

test("Commits and Pull Requests are tabs of their own, counted like every other view", async () => {
  renderDetail(
    buildPayload({
      commits: [commit()],
      pullRequests: [pullRequest(), pullRequest({ number: 392 })],
    }),
  )

  await tabsLoaded()

  expect(tabs().map((tab) => tab.textContent)).toEqual([
    expect.stringContaining("Conversation"),
    expect.stringContaining("Tool Calls"),
    expect.stringContaining("Artifacts"),
    expect.stringContaining("Commits"),
    expect.stringContaining("Pull Requests"),
    expect.stringContaining("Review"),
  ])
  expect(screen.getByRole("tab", { name: /Commits/ }).textContent).toContain("1")
  expect(screen.getByRole("tab", { name: /Pull Requests/ }).textContent).toContain("2")
})

test("a commit lists its sha, branch, diffstat and subject, linked to the repo it landed in", async () => {
  const user = userEvent.setup()
  renderDetail(buildPayload({ commits: [commit()] }))

  await tabsLoaded()
  await user.click(screen.getByRole("tab", { name: /Commits/ }))

  const panel = panelOf()
  expect(within(panel).getByRole("link", { name: "9f3c1ab" })).toHaveAttribute(
    "href",
    "https://github.com/acme/widgets/commit/9f3c1ab",
  )
  expect(within(panel).getByText("master")).toBeInTheDocument()
  expect(within(panel).getByText(/7 files · \+152 · -3/)).toBeInTheDocument()
  expect(within(panel).getByText(/make the upsert idempotent/)).toBeInTheDocument()
})

// Zero deletions arrive as null, so a count that was never captured must not be printed as 0.
test("a diffstat omits the counts capture did not record rather than showing them as zero", async () => {
  const user = userEvent.setup()
  renderDetail(buildPayload({ commits: [commit({ deletions: null, filesChanged: 1 })] }))

  await tabsLoaded()
  await user.click(screen.getByRole("tab", { name: /Commits/ }))

  const stat = within(panelOf()).getByText(/1 file/)
  expect(stat.textContent).toBe("1 file · +152")
})

test("a commit jumps to the transcript turn that produced it, landing on Conversation", async () => {
  const user = userEvent.setup()
  renderDetail(
    buildPayload({
      messages: [
        message({
          id: "say",
          lineNumber: 1,
          msgType: "message",
          role: "assistant",
          content: text("Committed it"),
        }),
      ],
      commits: [commit({ messageId: "say" })],
    }),
  )

  await tabsLoaded()
  await user.click(screen.getByRole("tab", { name: /Commits/ }))
  await user.click(within(panelOf()).getByRole("button", { name: /Jump to transcript/ }))

  expect(screen.getByRole("tab", { name: /Conversation/ })).toHaveAttribute("aria-selected", "true")
  expect(within(panelOf()).getByText(/Committed it/)).toBeInTheDocument()
  // Unconditional, even where the target renders without them: a jump lands on the full record.
  expect(screen.getByRole("checkbox", { name: /show tool calls inline/i })).toBeChecked()
})

// Capture files every commit against its `git commit` tool call, and Conversation hides tool
// records by default -- so a jump that left them hidden silently did nothing at all.
test("jumping to a commit made by a tool call reveals that call, rather than landing on nothing", async () => {
  const user = userEvent.setup()
  renderDetail(
    buildPayload({
      messages: [message({ id: "commit-call", lineNumber: 1, msgType: "toolCall" })],
      toolCalls: [
        {
          toolId: "t-commit",
          messageId: "commit-call",
          toolName: "Bash",
          toolInput: { command: "git commit -m wip" },
          result: null,
          status: "success",
        },
      ],
      commits: [commit({ messageId: "commit-call" })],
    }),
  )

  await tabsLoaded()
  await user.click(screen.getByRole("tab", { name: /Commits/ }))
  await user.click(within(panelOf()).getByRole("button", { name: /Jump to transcript/ }))

  expect(screen.getByRole("tab", { name: /Conversation/ })).toHaveAttribute("aria-selected", "true")
  expect(screen.getByRole("checkbox", { name: /show tool calls inline/i })).toBeChecked()
  expect(within(panelOf()).getByRole("button", { name: /Bash/ })).toBeInTheDocument()
})

test("a pull request lists the title and branches it was opened with", async () => {
  const user = userEvent.setup()
  renderDetail(buildPayload({ pullRequests: [pullRequest()] }))

  await tabsLoaded()
  await user.click(screen.getByRole("tab", { name: /Pull Requests/ }))

  const panel = panelOf()
  expect(within(panel).getByRole("link", { name: "#391" })).toHaveAttribute(
    "href",
    "https://github.com/acme/widgets/pull/391",
  )
  expect(within(panel).getByText("Make ingest idempotent")).toBeInTheDocument()
  expect(within(panel).getByText(/feat\/idempotent-ingest → master/)).toBeInTheDocument()
})

// A PR resolved from its URL alone carries no invocation to read, so the row must degrade
// rather than print "? → ?" where branches were never captured.
test("a pull request captured without its invocation shows no branch pair at all", async () => {
  const user = userEvent.setup()
  renderDetail(
    buildPayload({
      pullRequests: [pullRequest({ title: null, baseBranch: null, headBranch: null })],
    }),
  )

  await tabsLoaded()
  await user.click(screen.getByRole("tab", { name: /Pull Requests/ }))

  expect(panelOf().textContent).not.toContain("→")
  expect(within(panelOf()).getByText("unavailable")).toBeInTheDocument()
})

test("a session that recorded no pull requests says so, rather than showing an empty list", async () => {
  const user = userEvent.setup()
  renderDetail()

  await tabsLoaded()
  await user.click(screen.getByRole("tab", { name: /Pull Requests/ }))

  expect(within(panelOf()).getByText(/No pull requests recorded/)).toBeInTheDocument()
})

test("S37: thinking is present but collapsed on Conversation, so the prose leads and the reasoning is opt-in", async () => {
  renderDetail()

  await tabsLoaded()

  const summary = screen.getByText(/^Thinking$/)
  const thinking = summary.closest("details")
  expect(thinking).not.toBeNull()
  expect(thinking).not.toHaveAttribute("open")
  expect(within(panelOf()).getByText(/No unique constraint exists yet/)).toBeInTheDocument()
})

test("S37: ArrowRight, End, and Home move the selected tab under a roving tabindex, keeping exactly one tab reachable by Tab", async () => {
  const user = userEvent.setup()
  renderDetail()

  await tabsLoaded()

  const [conversation, toolCalls] = tabs()
  const last = tabs()[tabs().length - 1]
  conversation?.focus()

  await user.keyboard("{ArrowRight}")
  expect(toolCalls).toHaveAttribute("aria-selected", "true")
  expect(document.activeElement).toBe(toolCalls)
  expect(conversation).toHaveAttribute("tabindex", "-1")
  expect(toolCalls).toHaveAttribute("tabindex", "0")

  await user.keyboard("{End}")
  expect(last).toHaveAttribute("aria-selected", "true")

  await user.keyboard("{Home}")
  expect(conversation).toHaveAttribute("aria-selected", "true")

  await user.keyboard("{ArrowLeft}")
  expect(last).toHaveAttribute("aria-selected", "true")
})

test("S37: the masthead reports all six session facts from the payload", async () => {
  renderDetail()

  await tabsLoaded()

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

test("SC32: the breadcrumb links to the session's project by id, not its slug", async () => {
  renderDetail(
    buildPayload({ ...PAYLOAD, session: { projectId: "22222222-2222-4222-8222-222222222222" } }),
  )

  const breadcrumb = await screen.findByRole("navigation", { name: /breadcrumb/i })
  const link = await within(breadcrumb).findByRole("link", { name: "Samskara" })
  expect(link).toHaveAttribute("href", "/sessions?project=22222222-2222-4222-8222-222222222222")
})

const sessionFacts = () => screen.getByRole("group", { name: /session facts/i })
const factValue = (label: string) => within(sessionFacts()).getByText(label).nextElementSibling

test("SC24: the facts show a Started entry holding the first message time, and no Created entry", async () => {
  renderDetail()

  await tabsLoaded()

  expect(factValue("Started")?.textContent).toBe("Mar 1, 2026, 10:00")
  expect(within(sessionFacts()).queryByText("Created")).not.toBeInTheDocument()
})

test("SC25: an unknown start time reads as unavailable, as does a null duration", async () => {
  renderDetail(buildPayload({ ...PAYLOAD, session: { startedAt: null, durationMs: null } }))

  await tabsLoaded()

  expect(factValue("Started")?.textContent).toMatch(/unavailable/i)
  expect(factValue("Duration")?.textContent).toMatch(/unavailable/i)
})

test("S79: the facts report every token bucket the payload carries, so the strip agrees with the list page", async () => {
  renderDetail(
    buildPayload({
      ...PAYLOAD,
      tokenUsage: {
        inputTokens: 49_284,
        outputTokens: 5_145_110,
        cachedTokens: 2_118_565_132,
        thinkingTokens: 12_400,
      },
    }),
  )

  await tabsLoaded()

  expect(factValue("Tokens in")?.textContent).toBe("49,284")
  expect(factValue("Tokens out")?.textContent).toBe("5,145,110")
  expect(factValue("Tokens cached")?.textContent).toBe("2,118,565,132")
  expect(factValue("Tokens thinking")?.textContent).toBe("12,400")
})

test("S79: a session that did no thinking keeps the cached entry and drops the thinking one", async () => {
  renderDetail(
    buildPayload({ ...PAYLOAD, tokenUsage: { cachedTokens: 900_000, thinkingTokens: 0 } }),
  )

  await tabsLoaded()

  expect(factValue("Tokens cached")?.textContent).toBe("900,000")
  expect(within(sessionFacts()).queryByText("Tokens thinking")).not.toBeInTheDocument()
})

const metaLineOf = async (): Promise<string> => {
  await screen.findByRole("heading", { name: "Make ingest idempotent" })
  // The title is pinned in its own bar now, so the meta line is found from the facts it sits above.
  const masthead = screen.getByRole("group", { name: /session facts/i }).parentElement
  const line = masthead?.querySelector("p")
  return (line?.textContent ?? "").replace(/\s+/g, " ").trim()
}

test.each([
  {
    claim: "names the repo the session ran in, alongside project and user, linked",
    repo: { host: "github.com", owner: "acme", repoName: "samskara" },
    line: "Samskara·ritesh·acme/samskara",
    links: 1,
  },
  {
    claim: "names a remoteless repo but does not link it - there is no url to send a reader to",
    repo: { host: "local", owner: "/Users/maya/Projects/samskara", repoName: "samskara" },
    line: "Samskara·ritesh·samskara",
    links: 0,
  },
  {
    claim: "ends at the user when the session has no repo - no dangling separator",
    repo: null,
    line: "Samskara·ritesh",
    links: 0,
  },
])("S37: the masthead $claim", async ({ repo, line, links }) => {
  renderDetail(buildPayload({ ...PAYLOAD, session: { repo } }))

  expect(await metaLineOf()).toBe(line)
  expect(screen.queryAllByRole("link", { name: /^(acme\/)?samskara$/ })).toHaveLength(links)
})

test("S37: a remote-backed repo links out to the repo itself, on its own host", async () => {
  const repo = { host: "gitlab.example.com", owner: "acme", repoName: "samskara" }
  renderDetail(buildPayload({ ...PAYLOAD, session: { repo } }))

  const link = await screen.findByRole("link", { name: "acme/samskara" })
  expect(link).toHaveAttribute("href", "https://gitlab.example.com/acme/samskara")
  expect(link).toHaveAttribute("rel", expect.stringContaining("noreferrer"))
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

test("SC22: the artifacts panel lists the captured files for the session - both paths appear, a binary artifact shows its preview rather than a text body, and a null diff still renders", async () => {
  const user = userEvent.setup()
  renderDetail(PAYLOAD, {
    status: 200,
    body: {
      artifacts: [
        {
          ...CAPTURED,
          id: "cap-text",
          relativePath: "docs/notes.md",
          diff: null,
        },
        {
          ...CAPTURED,
          id: "cap-bin",
          relativePath: "docs/screenshot.png",
          mimeType: "image/png",
          isBinary: true,
          changeKind: "created",
          diff: null,
        },
      ],
    },
  })

  await tabsLoaded()
  await user.click(screen.getByRole("tab", { name: /Artifacts/ }))

  const list = await screen.findByRole("list", { name: /filed artifacts/i })
  expect(within(list).getByRole("button", { name: /notes\.md/ })).toBeInTheDocument()
  expect(within(list).getByRole("button", { name: /screenshot\.png/ })).toBeInTheDocument()

  const viewer = screen.getByRole("region", { name: /artifact viewer/i })
  expect(within(viewer).getByText(/no diff captured/i)).toBeInTheDocument()

  await user.click(within(list).getByRole("button", { name: /screenshot\.png/ }))
  expect(within(viewer).getByRole("img")).toHaveAttribute(
    "src",
    "/api/artifacts/cap-bin/raw?which=current",
  )
})

test("S49: a session with no captured artifacts reads empty rather than showing demo fixtures", async () => {
  const user = userEvent.setup()
  renderDetail(buildPayload({ messages: [message({ lineNumber: 1, msgType: "message" })] }))

  await tabsLoaded()
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

  await tabsLoaded()
  await user.click(screen.getByRole("tab", { name: /Artifacts/ }))

  const list = await screen.findByRole("list", { name: /filed artifacts/i })
  expect(within(list).getByRole("button", { name: /0007\.sql/ })).toBeInTheDocument()

  const viewer = screen.getByRole("region", { name: /artifact viewer/i })
  expect(within(viewer).getByText("migrations/0007.sql")).toBeInTheDocument()
})

test("S54: a failed artifact fetch leaves the other tabs working and shows a failure notice, not a blank pane", async () => {
  const user = userEvent.setup()
  renderDetail(PAYLOAD, { status: 500, body: { error: "boom" } })

  await tabsLoaded()

  expect(within(panelOf()).getByText(/Make it idempotent/)).toBeInTheDocument()

  await user.click(screen.getByRole("tab", { name: /Tool Calls/ }))
  expect(within(panelOf()).getAllByRole("button", { name: /Grep/ }).length).toBeGreaterThan(0)

  await user.click(screen.getByRole("tab", { name: /Artifacts/ }))
  const notice = await screen.findByText(/captured artifacts could not be retrieved/i)
  expect(notice).toBeInTheDocument()
})

test("S63: a branch reads like the main spine - its system events are dropped and its two assistant turns merge into a single block", async () => {
  const user = userEvent.setup()
  renderDetail(BRANCH_PAYLOAD)

  await tabsLoaded()
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

  await tabsLoaded()
  await user.click(screen.getByRole("button", { name: /open branch/i }))

  const branch = screen.getByRole("region", { name: /auditor conversation/i })
  await user.click(within(branch).getByRole("button", { name: /copy link to this message/i }))

  expect(await navigator.clipboard.readText()).toBe(
    `${window.location.origin}/sessions/s-1?agent=a1&m=branch-say`,
  )
})

test("S66: a link naming a message this transcript does not hold is ignored, leaving the session reading as it would without one", async () => {
  renderDetail(BRANCH_PAYLOAD, OK_EMPTY, "/sessions/s-1?m=not-in-this-session")

  await tabsLoaded()

  expect(screen.queryByText(/not part of this session/i)).not.toBeInTheDocument()
  expect(within(panelOf()).getByRole("button", { name: /open branch/i })).toBeInTheDocument()
})

test("S67: the linked record inside a branch is marked as the reader's location, so the shared line is identifiable among its neighbours", async () => {
  renderDetail(BRANCH_PAYLOAD, OK_EMPTY, "/sessions/s-1?m=branch-say")

  await tabsLoaded()

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

  await tabsLoaded()

  expect(screen.getByText(/Only answer/).closest("article")).toHaveAttribute(
    "aria-current",
    "location",
  )
  expect(screen.getByText(/Only prompt/).closest("article")).not.toHaveAttribute("aria-current")
})

test("S69: opening a branch records it in the query, so the branch a reader is looking at is itself shareable", async () => {
  const user = userEvent.setup()
  renderDetail(BRANCH_PAYLOAD)

  await tabsLoaded()
  await user.click(screen.getByRole("button", { name: /open branch/i }))

  expect(screen.getByTestId("location")).toHaveTextContent("/sessions/s-1?agent=a1")
})

test("S70: closing a branch drops it from the query rather than leaving a link that reopens it", async () => {
  const user = userEvent.setup()
  renderDetail(BRANCH_PAYLOAD, OK_EMPTY, "/sessions/s-1?agent=a1")

  await tabsLoaded()
  await user.click(await screen.findByRole("button", { name: /close branch/i }))

  expect(screen.getByTestId("location")).not.toHaveTextContent("agent=a1")
})

test("S71: arriving on a shared branch link opens that branch, so its records and their own links are reachable at once", async () => {
  renderDetail(BRANCH_PAYLOAD, OK_EMPTY, "/sessions/s-1?agent=a1")

  await tabsLoaded()

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

  await tabsLoaded()
  await waitFor(() => expect(scrolled).toContainEqual({ id: "spawn-a1", block: "start" }))
})

test("S73: a message permalink lands on the top of the record it names, so a tall merged block does not scroll past its own beginning", async () => {
  const scrolled = recordScrolls()

  renderDetail(BRANCH_PAYLOAD, OK_EMPTY, "/sessions/s-1?agent=a1&m=branch-say")

  await tabsLoaded()
  await waitFor(() => expect(scrolled).toContainEqual({ id: "r-branch-say", block: "start" }))
})

// Most branches share one agentType, so the type alone renders a column of identical rows. The
// description is the task the branch was given, which is what actually tells them apart.
test("S74: the rail names each branch by the task it was given, keeping its type as the secondary label", async () => {
  renderDetail(BRANCH_PAYLOAD)

  await tabsLoaded()

  const rail = screen.getByRole("complementary", { name: /agents in this session/i })
  const branch = within(rail).getByRole("button", { name: /audit keys/i })
  expect(branch).toHaveTextContent("Audit keys")
  expect(branch).toHaveTextContent("auditor")
})

test("S75: the rail reports no run status, so a branch is never labelled interrupted on evidence the capture does not have", async () => {
  renderDetail(BRANCH_PAYLOAD)

  await tabsLoaded()

  const rail = screen.getByRole("complementary", { name: /agents in this session/i })
  expect(within(rail).queryByText(/interrupted/i)).not.toBeInTheDocument()
  expect(within(rail).queryByText(/^done$/i)).not.toBeInTheDocument()
})

// A subagent can spawn its own subagents. Its annex is nested inside the parent's, so reaching it
// means opening the whole ancestry, not just the branch that was named.
test("S77: a link to a nested branch opens the parent branch holding it, so a subagent spawned by a subagent is reachable", async () => {
  renderDetail(NESTED_PAYLOAD, OK_EMPTY, "/sessions/s-1?agent=a2")

  await tabsLoaded()

  const nested = await screen.findByRole("region", { name: /researcher conversation/i })
  expect(within(nested).getByText(/Nested branch findings/)).toBeInTheDocument()
})

test("S78: the rail opens a nested branch too, so every agent it lists leads somewhere", async () => {
  const user = userEvent.setup()
  renderDetail(NESTED_PAYLOAD)

  await tabsLoaded()

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

  await tabsLoaded()

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

const REVIEW = {
  id: "rev-1",
  analyzer: "heuristic-v1",
  outcome: "struggled",
  friction: "high",
  summary: "struggled: the same Bash call failed three times in a row",
  signals: { turns: 4, toolCalls: 12, toolFailures: 6, commits: 0, userPrompts: 2 },
  createdAt: "2026-08-25T10:00:00.000Z",
}

test("the Review tab renders no verdict card for a static-only review", async () => {
  const user = userEvent.setup()
  renderDetail(PAYLOAD, OK_EMPTY, "/sessions/s-1", {
    review: { status: 200, body: { reviews: [REVIEW] } },
  })

  await tabsLoaded()
  await user.click(screen.getByRole("tab", { name: /Review/ }))

  const panel = panelOf()
  // The static analyzer no longer renders a card: the only verdict surface is the AI one,
  // so a static-only session offers Analyze instead of a verdict.
  expect(within(panel).getByRole("button", { name: /analyze with ai/i })).toBeInTheDocument()
  expect(
    within(panel).queryByText("The agent spent most of the session stuck."),
  ).not.toBeInTheDocument()
})

test("the Review tab stays quiet when no review exists — no verdict", async () => {
  const user = userEvent.setup()
  renderDetail()

  await tabsLoaded()
  await user.click(screen.getByRole("tab", { name: /Review/ }))

  expect(
    await within(panelOf()).findByText("This session has not been reviewed yet."),
  ).toBeInTheDocument()
  const panel = panelOf()
  // The static analyzer stays server-triggered; the one button here is the AI review's.
  expect(within(panel).getAllByRole("button")).toHaveLength(1)
  expect(within(panel).getByRole("button", { name: /analyze with ai/i })).toBeInTheDocument()
})

/** What GET /:id/aireview reports while a job for this session is still running. */
const RUNNING_JOB = {
  jobId: "job-live-1",
  status: "running",
  startedAt: "2026-08-26T09:00:00.000Z",
  lastEvent: { name: "harness_first_byte", at: "2026-08-26T09:00:04.000Z" },
}

/** An AI review as the review list carries it, with run.recordIds. */
const PROBLEMS_REVIEW_ROW = {
  id: "rev-p",
  analyzer: "ai-problems-v2",
  outcome: "struggled",
  friction: "heavy",
  summary: "The agent wrote the upsert twice before finding the missing constraint.",
  signals: {
    model: "fake-model",
    harness: "test-harness",
    run: { recordIds: ["m-1", "m-2", "tool-msg"] },
  },
  createdAt: "2026-08-26T18:00:00.000Z",
}

const PROBLEM = {
  id: "p-1",
  title: "Wrote the upsert before checking for a unique constraint",
  class: "slow",
  severity: "high",
  severityReason: "The first upsert failed and the work was redone.",
  fixType: "skill",
  description: "Expected a schema check first; the agent wrote the query and then found it.",
  evidence: [
    { from: "msg-1", to: "msg-2", quote: "Make it idempotent", why: "the ask needed a key" },
  ],
  learning: "Check the table's constraints before writing an upsert.",
  extra: {},
}

const problemsReply = (problems: ReadonlyArray<unknown>): Reply => ({
  status: 200,
  body: {
    review: {
      ...PROBLEMS_REVIEW_ROW,
      analyzedAt: PROBLEMS_REVIEW_ROW.createdAt,
      problems,
    },
  },
})

/** A review whose run captured the reviewer's own session, for the Reviewer session modal. */
const REVIEW_WITH_TRANSCRIPT = {
  ...PROBLEMS_REVIEW_ROW,
  outcome: "shipped",
  friction: "moderate",
  signals: {
    ...PROBLEMS_REVIEW_ROW.signals,
    run: {
      recordIds: ["m-1", "m-2", "tool-msg"],
      agentLog: "$ cat session.json\ncat: session.json: No such file or directory",
      transcript: [
        { role: "user", text: "review the exported session beside you" },
        {
          role: "assistant",
          text: "Reading the export first.",
          tools: [{ name: "Read", input: "/work/session.json" }],
        },
      ],
    },
  },
}

test("AI review: clicking Analyze starts a job, polls until it lands, and is replaced by the AI block", async () => {
  const user = userEvent.setup()
  renderDetail(PAYLOAD, OK_EMPTY, "/sessions/s-1", {
    review: { status: 200, body: { reviews: [REVIEW] } },
    analyze: { status: 202, body: { jobId: "job-9" } },
    // The job status is the landed signal: first poll tick reads running, second succeeded.
    analyzeJob: [
      {
        status: 200,
        body: {
          job: {
            status: "running",
            jobId: "job-9",
            startedAt: "2026-08-30T10:00:00Z",
            lastEvent: null,
          },
        },
      },
      { status: 200, body: { job: { status: "succeeded", jobId: "job-9", reviewId: "r-9" } } },
    ],
    aireview: [{ status: 404, body: { error: "noAiReview" } }],
    reviewAfterAi: { status: 200, body: { reviews: [PROBLEMS_REVIEW_ROW, REVIEW] } },
  })

  await tabsLoaded()
  await user.click(screen.getByRole("tab", { name: /Review/ }))
  const analyze = await within(panelOf()).findByRole("button", { name: /analyze with ai/i })

  // Fake timers drive the 3s poll; fireEvent keeps the click itself timer-free. The modal
  // runs under real timers (its options fetch must resolve) before the poll takes over.
  fireEvent.click(analyze)
  fireEvent.click(await screen.findByRole("button", { name: "Run analysis" }))
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
  expect(analyze).toBeDisabled()
  expect(within(panelOf()).getByText(/Analyzing… \(started/)).toBeInTheDocument()

  // First poll still answers 404, so the run goes on waiting.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000)
  })
  expect(within(panelOf()).getByText(/Analyzing…/)).toBeInTheDocument()

  // Second poll answers 200: the reviews list is re-fetched and the AI block renders.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000)
    await vi.advanceTimersByTimeAsync(0)
  })
  const panel = panelOf()
  expect(within(panel).getByText("AI review")).toBeInTheDocument()
  expect(within(panel).queryByRole("button", { name: /analyze with ai/i })).not.toBeInTheDocument()
  expect(within(panel).getByText(/fake-model · test-harness/)).toBeInTheDocument()
  expect(within(panel).getByText(/wrote the upsert twice/)).toBeInTheDocument()
})

test("AI review: a problems review renders its verdict, summary and problems with linked quotes", async () => {
  const user = userEvent.setup()
  renderDetail(PAYLOAD, OK_EMPTY, "/sessions/s-1", {
    review: { status: 200, body: { reviews: [PROBLEMS_REVIEW_ROW, REVIEW] } },
    aireview: problemsReply([PROBLEM]),
  })

  await tabsLoaded()
  await user.click(screen.getByRole("tab", { name: /Review/ }))

  const panel = panelOf()
  expect(within(panel).queryByRole("button", { name: /analyze with ai/i })).not.toBeInTheDocument()
  expect(within(panel).getByText("AI review")).toBeInTheDocument()
  expect(within(panel).getByText("The agent spent most of the session stuck.")).toBeInTheDocument()
  expect(within(panel).getByText(/fake-model · test-harness/)).toBeInTheDocument()
  expect(within(panel).getByText(/wrote the upsert twice/)).toBeInTheDocument()

  const row = await within(panel).findByRole("button", { name: /Wrote the upsert before/ })
  expect(within(row).getByText("high")).toBeInTheDocument()
  expect(within(row).getByText(/slow · fix: skill/)).toBeInTheDocument()

  await user.click(row)
  expect(within(panel).getByText(/Expected a schema check first/)).toBeInTheDocument()
  expect(within(panel).getByText(/The first upsert failed/)).toBeInTheDocument()
  expect(within(panel).getByText(/Make it idempotent/)).toBeInTheDocument()
  expect(within(panel).getByText(/Check the table's constraints/)).toBeInTheDocument()
  // msg-1 is an export alias: run.recordIds turns it into the real message id.
  const quote = within(panel).getByRole("link", { name: "msg-1 to msg-2" })
  expect(quote).toHaveAttribute("href", expect.stringContaining("tab=conversation"))
  expect(quote).toHaveAttribute("href", expect.stringContaining("m=m-2"))
})

test("AI review: a problems review that found nothing says so", async () => {
  const user = userEvent.setup()
  renderDetail(PAYLOAD, OK_EMPTY, "/sessions/s-1", {
    review: { status: 200, body: { reviews: [PROBLEMS_REVIEW_ROW] } },
    aireview: problemsReply([]),
  })

  await tabsLoaded()
  await user.click(screen.getByRole("tab", { name: /Review/ }))

  expect(await within(panelOf()).findByText("No problems found.")).toBeInTheDocument()
  expect(
    within(panelOf()).queryByRole("button", { name: /analyze with ai/i }),
  ).not.toBeInTheDocument()
})

test("AI review: a 403 from analyze explains edit rights instead of starting a run", async () => {
  const user = userEvent.setup()
  renderDetail(PAYLOAD, OK_EMPTY, "/sessions/s-1", {
    analyze: { status: 403, body: { error: "notEditable" } },
  })

  await tabsLoaded()
  await user.click(screen.getByRole("tab", { name: /Review/ }))
  await user.click(await within(panelOf()).findByRole("button", { name: /analyze with ai/i }))
  await user.click(await screen.findByRole("button", { name: "Run analysis" }))

  expect(
    await within(panelOf()).findByText("You need edit rights on this project to run an AI review."),
  ).toBeInTheDocument()
  expect(within(panelOf()).queryByText(/Analyzing…/)).not.toBeInTheDocument()
})

test("AI review: a 503 from analyze reports the queue is full and keeps the button for a retry", async () => {
  const user = userEvent.setup()
  renderDetail(PAYLOAD, OK_EMPTY, "/sessions/s-1", {
    analyze: { status: 503, body: { error: "busy" } },
  })

  await tabsLoaded()
  await user.click(screen.getByRole("tab", { name: /Review/ }))
  await user.click(await within(panelOf()).findByRole("button", { name: /analyze with ai/i }))
  await user.click(await screen.findByRole("button", { name: "Run analysis" }))

  expect(
    await within(panelOf()).findByText(
      "The server is running 4 analyses already — try again in a minute.",
    ),
  ).toBeInTheDocument()
  expect(within(panelOf()).getByRole("button", { name: /analyze with ai/i })).toBeEnabled()
})

// The reported bug: reload mid-run lost the page's memory of the running job, so the
// Analyze button came back and a second click spawned a duplicate run. The mount probe
// reads GET /:id/aireview, sees the running job, and rejoins the existing poll.
test("AI review: a reload joins the running job — Analyzing shows without a click and the poll lands the card", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] })
  renderDetail(PAYLOAD, OK_EMPTY, "/sessions/s-1?tab=review", {
    aireview: [
      // The mount probe reads the running job (and rejoins it by id).
      { status: 200, body: { review: null, job: RUNNING_JOB } },
    ],
    analyzeJob: [
      {
        status: 200,
        body: {
          job: {
            status: "running",
            jobId: "job-live-1",
            startedAt: "2026-08-26T09:00:00.000Z",
            lastEvent: null,
          },
        },
      },
      {
        status: 200,
        body: { job: { status: "succeeded", jobId: "job-live-1", reviewId: "r-live" } },
      },
    ],
    reviewAfterAi: { status: 200, body: { reviews: [PROBLEMS_REVIEW_ROW, REVIEW] } },
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })

  // No click ever happened: the page joined the run it found on load.
  expect(screen.getByText(/Analyzing… \(started/)).toBeInTheDocument()
  expect(screen.getByRole("button", { name: /analyze with ai/i })).toBeDisabled()

  // First poll: the job is still running, so the wait goes on.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000)
  })
  expect(screen.getByText(/Analyzing…/)).toBeInTheDocument()

  // Second poll: the review lands, the list refetches, and the card replaces the button.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000)
    await vi.advanceTimersByTimeAsync(0)
  })
  expect(screen.getByText("AI review")).toBeInTheDocument()
  expect(screen.queryByRole("button", { name: /analyze with ai/i })).not.toBeInTheDocument()
})

test("AI review: 409 analysisAlreadyExists treats the verdict as arrived — the list refetch paints the card", async () => {
  const user = userEvent.setup()
  renderDetail(PAYLOAD, OK_EMPTY, "/sessions/s-1", {
    analyze: { status: 409, body: { error: "analysisAlreadyExists" } },
    aireview: [{ status: 404, body: { error: "noAiReview" } }],
    reviewAfterAi: { status: 200, body: { reviews: [PROBLEMS_REVIEW_ROW, REVIEW] } },
  })

  await tabsLoaded()
  await user.click(screen.getByRole("tab", { name: /Review/ }))
  await user.click(await within(panelOf()).findByRole("button", { name: /analyze with ai/i }))
  await user.click(await screen.findByRole("button", { name: "Run analysis" }))

  const panel = panelOf()
  expect(await within(panel).findByText("AI review")).toBeInTheDocument()
  expect(within(panel).queryByRole("button", { name: /analyze with ai/i })).not.toBeInTheDocument()
  expect(within(panel).queryByText(/Analyzing…/)).not.toBeInTheDocument()
})

test("AI review: the modal offers the server's reviewer choices and posts the picked harness and model", async () => {
  const user = userEvent.setup()
  const view = renderDetail(PAYLOAD, OK_EMPTY, "/sessions/s-1")

  await tabsLoaded()
  await user.click(screen.getByRole("tab", { name: /Review/ }))
  await user.click(await within(panelOf()).findByRole("button", { name: /analyze with ai/i }))

  // The dialog preselects the server's env defaults, with both harnesses offered live.
  const harness = await screen.findByLabelText("Reviewer harness")
  expect(harness).toHaveValue("opencode")
  expect(screen.getByLabelText("Model")).toHaveValue("zai-coding-plan/glm-5.3-flash")

  // Switching harnesses swaps the model list and preselects that harness's default.
  await user.selectOptions(harness, "claude")
  expect(screen.getByLabelText("Model")).toHaveValue("sonnet")

  await user.click(screen.getByRole("button", { name: "Run analysis" }))
  expect(view.analyzeBodies.at(-1)).toEqual({ harness: "claude", model: "sonnet" })
})

test("AI review: an unavailable default harness is not preselected; the first usable one is", async () => {
  const user = userEvent.setup()
  const view = renderDetail(PAYLOAD, OK_EMPTY, "/sessions/s-1", {
    reviewerOptions: {
      status: 200,
      body: {
        defaultHarness: "opencode",
        defaultModel: "zai-coding-plan/glm-5.3-flash",
        harnesses: [
          {
            harness: "opencode",
            defaultModel: "zai-coding-plan/glm-5.3-flash",
            available: false,
            models: ["zai-coding-plan/glm-5.3-flash"],
          },
          { harness: "claude", defaultModel: "sonnet", available: true, models: ["sonnet"] },
        ],
      },
    },
  })

  await tabsLoaded()
  await user.click(screen.getByRole("tab", { name: /Review/ }))
  await user.click(await within(panelOf()).findByRole("button", { name: /analyze with ai/i }))

  expect(await screen.findByLabelText("Reviewer harness")).toHaveValue("claude")
  expect(screen.getByLabelText("Model")).toHaveValue("sonnet")

  await user.click(screen.getByRole("button", { name: "Run analysis" }))
  expect(view.analyzeBodies.at(-1)).toEqual({ harness: "claude", model: "sonnet" })
})

test("AI review: a joined run that fails surfaces the failure instead of analyzing forever", async () => {
  const user = userEvent.setup()
  renderDetail(PAYLOAD, OK_EMPTY, "/sessions/s-1", {
    analyze: { status: 409, body: { error: "analysisAlreadyRunning" } },
    aireview: [
      { status: 404, body: { error: "noAiReview" } },
      { status: 200, body: { review: null, job: RUNNING_JOB } },
      { status: 404, body: { error: "noAiReview" } },
    ],
    analyzeJob: {
      status: 200,
      body: { job: { status: "failed", jobId: RUNNING_JOB.jobId, code: "unparseable" } },
    },
  })

  await tabsLoaded()
  await user.click(screen.getByRole("tab", { name: /Review/ }))
  const analyze = await within(panelOf()).findByRole("button", { name: /analyze with ai/i })

  fireEvent.click(analyze)
  fireEvent.click(await screen.findByRole("button", { name: "Run analysis" }))
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
  expect(within(panelOf()).getByText(/Analyzing… \(started/)).toBeInTheDocument()

  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000)
    await vi.advanceTimersByTimeAsync(3000)
    await vi.advanceTimersByTimeAsync(0)
  })
  expect(within(panelOf()).getByRole("alert")).toHaveTextContent(/Analysis failed/)
  expect(analyze).toBeEnabled()
})

test("AI review: a failed job surfaces its reason, re-enables Analyze, and stops saying Analyzing", async () => {
  const user = userEvent.setup()
  renderDetail(PAYLOAD, OK_EMPTY, "/sessions/s-1", {
    analyzeJob: [
      {
        status: 200,
        body: {
          job: {
            status: "failed",
            jobId: "job-1",
            code: "unparseable",
            detail: {
              error:
                'outcome: Invalid option: expected one of "shipped"|"productive"|"struggled"|"aborted"',
            },
          },
        },
      },
    ],
  })

  await tabsLoaded()
  await user.click(screen.getByRole("tab", { name: /Review/ }))
  const analyze = await within(panelOf()).findByRole("button", { name: /analyze with ai/i })
  fireEvent.click(analyze)
  fireEvent.click(await screen.findByRole("button", { name: "Run analysis" }))

  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] })
  // Flush the POST resolution so the poll interval registers, then tick it once.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000)
  })

  expect(within(panelOf()).getByText(/Analysis failed/i)).toBeInTheDocument()
  expect(within(panelOf()).getByText(/outcome: Invalid option/i)).toBeInTheDocument()
  expect(within(panelOf()).queryByText(/Analyzing…/)).not.toBeInTheDocument()
  expect(analyze).toBeEnabled()
})

test("AI review: 409 analysisAlreadyRunning joins the existing run and polls it to the verdict", async () => {
  const user = userEvent.setup()
  renderDetail(PAYLOAD, OK_EMPTY, "/sessions/s-1", {
    analyze: { status: 409, body: { error: "analysisAlreadyRunning" } },
    aireview: [
      // Mount probe: nothing running yet from this tab's point of view.
      { status: 404, body: { error: "noAiReview" } },
      // The click's conflict said someone else is running; the poll adopts that job's id.
      { status: 200, body: { review: null, job: RUNNING_JOB } },
      { status: 200, body: { review: PROBLEMS_REVIEW_ROW } },
    ],
    analyzeJob: {
      status: 200,
      body: {
        job: { status: "succeeded", jobId: RUNNING_JOB.jobId, reviewId: PROBLEMS_REVIEW_ROW.id },
      },
    },
    reviewAfterAi: { status: 200, body: { reviews: [PROBLEMS_REVIEW_ROW, REVIEW] } },
  })

  await tabsLoaded()
  await user.click(screen.getByRole("tab", { name: /Review/ }))
  const analyze = await within(panelOf()).findByRole("button", { name: /analyze with ai/i })

  fireEvent.click(analyze)
  fireEvent.click(await screen.findByRole("button", { name: "Run analysis" }))
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
  expect(analyze).toBeDisabled()
  expect(within(panelOf()).getByText(/Analyzing… \(started/)).toBeInTheDocument()

  // Tick 1 adopts the running job; tick 2 reads it succeeded and refetches the list.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000)
    await vi.advanceTimersByTimeAsync(3000)
    await vi.advanceTimersByTimeAsync(0)
  })
  expect(within(panelOf()).getByText("AI review")).toBeInTheDocument()
  expect(
    within(panelOf()).queryByRole("button", { name: /analyze with ai/i }),
  ).not.toBeInTheDocument()
})

// AI-9c: the verdict is one plain-language sentence built from outcome+friction — the
// stamp vocabulary (SHIPPED/MODERATE) is the anchor word, never the verdict itself.
test.each([
  ["shipped", "none", "Delivered cleanly — the task's artifact landed with nothing to flag."],
  ["shipped", "moderate", "Delivered, after real friction — the why lives in the summary below."],
  ["shipped", "high", "Delivered, but most of the session was fighting friction."],
  ["productive", "none", "Useful work, nothing delivered to show."],
  ["productive", "moderate", "Useful work, nothing delivered to show, after some friction."],
  ["productive", "high", "Useful work, nothing delivered to show, after heavy friction."],
  ["struggled", "none", "The agent spent most of the session stuck."],
  ["struggled", "high", "The agent spent most of the session stuck."],
  ["aborted", "moderate", "The session ended before the work finished."],
  ["clarified", "none", "Mostly back-and-forth to shape the task."],
  ["mysterious", "high", "The review reported mysterious with high friction."],
])(
  "verdict sentence: %s + %s reads as the sentence the owner ruled",
  (outcome, friction, expected) => {
    expect(verdictSentence(outcome, friction)).toBe(expected)
  },
)

test("AI-9c: the verdict is built from the review's own friction, and the reviewer session modal renders the transcript like a conversation - roles, text, inline tools", async () => {
  const user = userEvent.setup()
  renderDetail(PAYLOAD, OK_EMPTY, "/sessions/s-1", {
    review: { status: 200, body: { reviews: [REVIEW_WITH_TRANSCRIPT] } },
  })

  await tabsLoaded()
  await user.click(screen.getByRole("tab", { name: /Review/ }))
  expect(within(panelOf()).getByText(/^Delivered, after real friction/)).toBeInTheDocument()
  await user.click(await screen.findByRole("button", { name: "Reviewer session" }))

  const dialog = screen.getByRole("dialog")
  // Roles render the same way the conversation tab attributes records.
  expect(dialog.querySelector('[data-actor="user"]')).not.toBeNull()
  expect(dialog.querySelector('[data-actor="assistant"]')).not.toBeNull()
  expect(dialog.textContent).toContain("review the exported session beside you")
  expect(dialog.textContent).toContain("Reading the export first.")
  expect(dialog.textContent).toContain("Read")
  expect(dialog.textContent).toContain("/work/session.json")

  await user.click(within(dialog).getByRole("button", { name: "Close" }))
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
})

test("AI review: a failed redo surfaces its reason on the card instead of dying silently", async () => {
  const user = userEvent.setup()
  renderDetail(PAYLOAD, OK_EMPTY, "/sessions/s-1", {
    review: { status: 200, body: { reviews: [REVIEW_WITH_TRANSCRIPT] } },
    analyze: { status: 500, body: { error: "internal" } },
  })

  await tabsLoaded()
  await user.click(screen.getByRole("tab", { name: /Review/ }))
  await user.click(await screen.findByRole("button", { name: "Redo review" }))
  await user.click(await screen.findByRole("button", { name: "Run analysis" }))

  const panel = panelOf()
  expect(await within(panel).findByText(/Redo failed/)).toBeInTheDocument()
  expect(within(panel).getByRole("button", { name: "Redo review" })).toBeEnabled()
})

test("AI review: a reload while a redo is running shows Redo running on the existing card, not a fresh button", async () => {
  renderDetail(PAYLOAD, OK_EMPTY, "/sessions/s-1?tab=review", {
    review: { status: 200, body: { reviews: [PROBLEMS_REVIEW_ROW, REVIEW] } },
    aireview: [
      // The mount probe: the old review is on the page AND a redo job is in flight.
      { status: 200, body: { review: PROBLEMS_REVIEW_ROW, job: RUNNING_JOB } },
    ],
  })
  await waitFor(() => expect(screen.getByText(/Redo running… \(started/)).toBeInTheDocument())
  expect(screen.getByRole("button", { name: /redo running/i })).toBeDisabled()
}, 10_000)

test("EDGE-008: a 404 from the detail endpoint renders a not-found state whose button leads back to the list, not a blank panel", async () => {
  const user = userEvent.setup()
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
  expect(screen.queryByRole("tab")).not.toBeInTheDocument()
  await user.click(screen.getByRole("button", { name: /back to all sessions/i }))
  expect(screen.getByTestId("location")).toHaveTextContent(/^\/sessions$/)
})

test("S63: the transcript marks who each record came from, so a prompt and a reply are told apart without reading them", async () => {
  renderDetail()

  await tabsLoaded()
  const panel = panelOf()

  const prompt = panel.querySelector('[data-actor="user"]')
  expect(prompt?.textContent).toContain("Make it idempotent")

  const reply = panel.querySelector('[data-actor="assistant"]')
  expect(reply?.textContent).toContain("Here is the plan for the upsert")

  // A branch event is neither: nobody typed it and Claude did not say it.
  expect(panel.querySelectorAll('[data-actor="aside"]').length).toBeGreaterThan(0)
})

test("S63: every record in the transcript carries an actor, so none renders unattributed", async () => {
  renderDetail()

  await tabsLoaded()
  const panel = panelOf()

  const records = panel.querySelectorAll("article")
  expect(records.length).toBeGreaterThan(0)
  for (const record of records) {
    expect(["user", "assistant", "aside"]).toContain(record.getAttribute("data-actor"))
  }
})

test("SC14: the header shows the human name with the captured title beneath it", async () => {
  renderDetail(
    buildPayload({
      session: {
        name: "Ingest cleanup",
        title: "Ingest cleanup",
        aiTitle: "Session issue investigation",
      },
    }),
  )

  await screen.findByRole("heading", { level: 1, name: "Ingest cleanup" })
  expect(screen.getByText(/AI title: Session issue investigation/)).toBeInTheDocument()
})

test.each([
  { claim: "SC15: a session with no human name", name: null },
  { claim: "SC30: a name identical to the captured title", name: "Captured title" },
])("$claim shows one title and no AI-title line", async ({ name }) => {
  renderDetail(
    buildPayload({ session: { name, title: "Captured title", aiTitle: "Captured title" } }),
  )

  await screen.findByRole("heading", { level: 1, name: "Captured title" })
  expect(screen.queryByText(/AI title:/)).not.toBeInTheDocument()
})

test("SC16: the edit control appears only for someone allowed to use it", async () => {
  const { unmount } = renderDetail(buildPayload({ session: { canRename: true } }))
  await screen.findByRole("heading", { level: 1 })
  expect(screen.getByRole("button", { name: /edit/i })).toBeInTheDocument()
  unmount()

  renderDetail(buildPayload({ session: { canRename: false } }))
  await screen.findByRole("heading", { level: 1 })
  expect(screen.queryByRole("button", { name: /edit/i })).not.toBeInTheDocument()
})

test("SC17: saving sends the edited values and shows them", async () => {
  const user = userEvent.setup()
  const sent: Array<unknown> = []

  renderDetailWithFetch((input, init) => {
    const url = typeof input === "string" ? input : String(input)
    if (url.includes("/artifacts")) return Promise.resolve(jsonResponse(200, { artifacts: [] }))
    if (url.includes("/api/sessions/") && isPatch(init)) {
      sent.push(init?.body ? JSON.parse(String(init.body)) : null)
      return Promise.resolve(
        jsonResponse(200, {
          session: facts({
            name: "New name",
            description: "New description",
            aiTitle: "Make ingest idempotent",
            title: "New name",
          }),
        }),
      )
    }
    if (url.includes("/api/sessions/")) return Promise.resolve(jsonResponse(200, PAYLOAD))
    return Promise.resolve(jsonResponse(401, { error: "unauthorized" }))
  })

  await screen.findByRole("heading", { level: 1, name: "Make ingest idempotent" })
  await user.click(screen.getByRole("button", { name: /edit/i }))

  await user.clear(screen.getByRole("textbox", { name: "Name" }))
  await user.type(screen.getByRole("textbox", { name: "Name" }), "New name")
  await user.clear(screen.getByRole("textbox", { name: "Description" }))
  await user.type(screen.getByRole("textbox", { name: "Description" }), "New description")
  await user.click(screen.getByRole("button", { name: /save/i }))

  await screen.findByRole("heading", { level: 1, name: "New name" })
  expect(sent).toEqual([{ name: "New name", description: "New description" }])
  expect(screen.getByText("New description")).toBeInTheDocument()
  expect(screen.queryByRole("textbox", { name: "Name" })).not.toBeInTheDocument()
})

test("SC18: cancelling discards the edits and sends nothing", async () => {
  const user = userEvent.setup()
  const patched: Array<RequestInit | undefined> = []

  renderDetailWithFetch((input, init) => {
    const url = typeof input === "string" ? input : String(input)
    if (url.includes("/artifacts")) return Promise.resolve(jsonResponse(200, { artifacts: [] }))
    if (url.includes("/api/sessions/")) {
      if (isPatch(init)) patched.push(init)
      return Promise.resolve(jsonResponse(200, PAYLOAD))
    }
    return Promise.resolve(jsonResponse(401, { error: "unauthorized" }))
  })

  await screen.findByRole("heading", { level: 1, name: "Make ingest idempotent" })
  await user.click(screen.getByRole("button", { name: /edit/i }))
  await user.type(screen.getByRole("textbox", { name: "Name" }), "Discarded")
  await user.type(screen.getByRole("textbox", { name: "Description" }), "Discarded too")
  await user.click(screen.getByRole("button", { name: /cancel/i }))

  expect(patched).toHaveLength(0)
  expect(
    screen.getByRole("heading", { level: 1, name: "Make ingest idempotent" }),
  ).toBeInTheDocument()

  await user.click(screen.getByRole("button", { name: /edit/i }))
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("")
  expect(screen.getByRole("textbox", { name: "Description" })).toHaveValue("")
})

test("SC19: a failed save keeps the form open and names the failure", async () => {
  const user = userEvent.setup()

  renderDetailWithFetch((input, init) => {
    const url = typeof input === "string" ? input : String(input)
    if (url.includes("/artifacts")) return Promise.resolve(jsonResponse(200, { artifacts: [] }))
    if (url.includes("/api/sessions/") && isPatch(init))
      return Promise.resolve(jsonResponse(403, { error: "forbidden" }))
    if (url.includes("/api/sessions/")) return Promise.resolve(jsonResponse(200, PAYLOAD))
    return Promise.resolve(jsonResponse(401, { error: "unauthorized" }))
  })

  await screen.findByRole("heading", { level: 1, name: "Make ingest idempotent" })
  await user.click(screen.getByRole("button", { name: /edit/i }))
  await user.type(screen.getByRole("textbox", { name: "Name" }), "Attempted rename")
  await user.click(screen.getByRole("button", { name: /save/i }))

  expect(await screen.findByRole("alert")).toBeInTheDocument()
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Attempted rename")
  expect(
    screen.getByRole("heading", { level: 1, name: "Make ingest idempotent" }),
  ).toBeInTheDocument()
})

test("SC31: a save that lands for a different session is ignored", async () => {
  const user = userEvent.setup()

  renderDetailWithFetch((input, init) => {
    const url = typeof input === "string" ? input : String(input)
    if (url.includes("/artifacts")) return Promise.resolve(jsonResponse(200, { artifacts: [] }))
    if (url.includes("/api/sessions/") && isPatch(init)) {
      return Promise.resolve(
        jsonResponse(200, {
          session: { ...PAYLOAD.session, id: "s-elsewhere", title: "Someone else's session" },
        }),
      )
    }
    if (url.includes("/api/sessions/")) return Promise.resolve(jsonResponse(200, PAYLOAD))
    return Promise.resolve(jsonResponse(401, { error: "unauthorized" }))
  })

  await screen.findByRole("heading", { level: 1, name: "Make ingest idempotent" })
  await user.click(screen.getByRole("button", { name: /edit/i }))
  await user.type(screen.getByRole("textbox", { name: "Name" }), "Renamed")
  await user.click(screen.getByRole("button", { name: /save/i }))

  await waitFor(() =>
    expect(screen.queryByRole("textbox", { name: "Name" })).not.toBeInTheDocument(),
  )
  expect(
    screen.getByRole("heading", { level: 1, name: "Make ingest idempotent" }),
  ).toBeInTheDocument()
  expect(screen.queryByText("Someone else's session")).not.toBeInTheDocument()
})

test("SC20: clearing the name in the form restores the derived title", async () => {
  const user = userEvent.setup()
  const sent: Array<unknown> = []
  const named = buildPayload({
    session: { name: "Ingest cleanup", title: "Ingest cleanup", aiTitle: "Captured title" },
  })

  renderDetailWithFetch((input, init) => {
    const url = typeof input === "string" ? input : String(input)
    if (url.includes("/artifacts")) return Promise.resolve(jsonResponse(200, { artifacts: [] }))
    if (url.includes("/api/sessions/") && isPatch(init)) {
      sent.push(init?.body ? JSON.parse(String(init.body)) : null)
      return Promise.resolve(
        jsonResponse(200, {
          session: facts({
            name: null,
            description: null,
            title: "Captured title",
            aiTitle: "Captured title",
          }),
        }),
      )
    }
    if (url.includes("/api/sessions/")) return Promise.resolve(jsonResponse(200, named))
    return Promise.resolve(jsonResponse(401, { error: "unauthorized" }))
  })

  await screen.findByRole("heading", { level: 1, name: "Ingest cleanup" })
  await user.click(screen.getByRole("button", { name: /edit/i }))
  await user.clear(screen.getByRole("textbox", { name: "Name" }))
  await user.click(screen.getByRole("button", { name: /save/i }))

  await screen.findByRole("heading", { level: 1, name: "Captured title" })
  expect(sent).toEqual([{ name: null, description: null }])
  expect(screen.queryByText(/AI title:/)).not.toBeInTheDocument()
})

test("ST8: typing a new tag sends it as an add, and removing a chip sends it as a remove", async () => {
  const user = userEvent.setup()
  const sent: Array<unknown> = []
  const tagged = {
    ...PAYLOAD,
    session: { ...PAYLOAD.session, tags: ["harness"] },
  }

  renderDetailWithFetch((input, init) => {
    const url = typeof input === "string" ? input : String(input)
    if (url.includes("/artifacts")) return Promise.resolve(jsonResponse(200, { artifacts: [] }))
    if (url.includes("/tags") && isPatch(init)) {
      sent.push(JSON.parse(String(init?.body)))
      return Promise.resolve(jsonResponse(200, { session: tagged.session }))
    }
    if (url.includes("/api/sessions/")) return Promise.resolve(jsonResponse(200, PAYLOAD))
    return Promise.resolve(jsonResponse(401, { error: "unauthorized" }))
  })

  await screen.findByRole("heading", { level: 1, name: "Make ingest idempotent" })

  await user.click(screen.getByRole("button", { name: "Add tag" }))
  await user.type(screen.getByRole("combobox", { name: "Add a tag" }), "harness{Enter}")

  await screen.findByRole("button", { name: "Remove harness" })
  expect(sent).toEqual([{ add: ["harness"] }])

  await user.click(screen.getByRole("button", { name: "Remove harness" }))
  expect(sent).toEqual([{ add: ["harness"] }, { remove: ["harness"] }])
})

const longText = (marker: string): string =>
  [marker, ...Array.from({ length: 39 }, (_, i) => `${marker} line ${i + 2}`)].join("\n")

const articleOf = (root: HTMLElement, pattern: RegExp): HTMLElement => {
  const article = within(root).getAllByText(pattern)[0]?.closest("article")
  if (!(article instanceof HTMLElement)) throw new Error(`no article holds ${pattern}`)
  return article
}

const collapseButtons = (article: HTMLElement) =>
  within(article).queryAllByRole("button", { name: "Collapse message" })

test("SC6: a 40-line prompt and a 40-line reply each get collapse buttons, while one-line ones get none", async () => {
  renderDetail(
    buildPayload({
      messages: [
        message({
          lineNumber: 1,
          msgType: "message",
          role: "user",
          content: text(longText("LONGASK")),
        }),
        message({
          lineNumber: 2,
          msgType: "message",
          role: "assistant",
          content: text(longText("LONGSAY")),
        }),
        message({ lineNumber: 3, msgType: "message", role: "user", content: text("SHORTASK") }),
        message({
          lineNumber: 4,
          msgType: "message",
          role: "assistant",
          content: text("SHORTSAY"),
        }),
      ],
    }),
  )

  await tabsLoaded()

  const panel = panelOf()
  expect(collapseButtons(articleOf(panel, /LONGASK/))).toHaveLength(2)
  expect(collapseButtons(articleOf(panel, /LONGSAY/))).toHaveLength(2)
  expect(collapseButtons(articleOf(panel, /SHORTASK/))).toHaveLength(0)
  expect(collapseButtons(articleOf(panel, /SHORTSAY/))).toHaveLength(0)
})

test("SC7: collapsing a long reply leaves its thinking outside the folded body and still closed", async () => {
  const user = userEvent.setup()
  renderDetail(
    buildPayload({
      messages: [
        message({
          lineNumber: 1,
          msgType: "message",
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Weighing the upsert" },
            { type: "text", text: longText("LONGSAY") },
          ],
        }),
      ],
    }),
  )

  await tabsLoaded()

  const [top] = collapseButtons(articleOf(panelOf(), /LONGSAY/))
  if (top === undefined) throw new Error("no collapse button")
  await user.click(top)

  const expand = screen.getByRole("button", { name: "Show full message" })
  const body = document.getElementById(expand.getAttribute("aria-controls") ?? "")
  expect(body).not.toBeNull()
  const thinking = screen.getByText(/^Thinking$/).closest("details")
  expect(body?.contains(thinking ?? null)).toBe(false)
  expect(thinking).not.toHaveAttribute("open")
})

test("SC8: a 40-line slash command argument and a 40-line skill injection get no collapse buttons", async () => {
  renderDetail(
    buildPayload({
      messages: [
        message({
          lineNumber: 1,
          msgType: "localCommand",
          details: { command: "/plan", commandType: "slash", args: longText("LONGARGS") },
        }),
        message({
          lineNumber: 2,
          msgType: "message",
          role: "user",
          subType: "toolInjection",
          content: text(`Base directory for this skill: /skills/plan\n\n${longText("LONGSKILL")}`),
        }),
      ],
    }),
  )

  await tabsLoaded()

  const panel = panelOf()
  const command = articleOf(panel, /LONGARGS/)
  expect(collapseButtons(command)).toHaveLength(0)
  expect(within(command).getAllByText(/LONGARGS/)[0]).toBeVisible()

  const injected = within(panel).getByText("Skill Loaded — plan").closest("article")
  if (!(injected instanceof HTMLElement)) throw new Error("no injection article")
  expect(collapseButtons(injected)).toHaveLength(0)
  expect(injected.querySelector("details")).not.toHaveAttribute("open")
})

test("SC9: a 40-line reply inside an opened subagent branch gets collapse buttons", async () => {
  const user = userEvent.setup()
  renderDetail(
    buildPayload({
      subagents: [
        {
          agentId: "a1",
          agentType: "auditor",
          description: "Audit keys",
          parentAgentId: null,
          spawnToolUseId: null,
        },
      ],
      messages: [
        message({ lineNumber: 1, msgType: "turnEvent", subType: "agentSpawn", agentId: "a1" }),
        message({
          lineNumber: 2,
          msgType: "message",
          role: "assistant",
          agentId: "a1",
          isSubagent: true,
          content: text(longText("BRANCHSAY")),
        }),
      ],
    }),
  )

  await tabsLoaded()
  await user.click(screen.getByRole("button", { name: /open branch/i }))

  const branch = screen.getByRole("region", { name: /auditor conversation/i })
  expect(collapseButtons(articleOf(branch, /BRANCHSAY/))).toHaveLength(2)
})

test("following a permalink to a collapsed long reply reopens it in the conversation", async () => {
  const user = userEvent.setup()
  renderDetail(
    buildPayload({
      messages: [
        message({
          id: "long-say",
          lineNumber: 1,
          msgType: "message",
          role: "assistant",
          content: text(longText("LONGSAY")),
        }),
      ],
    }),
    OK_EMPTY,
    "/sessions/s-1",
    { beside: <Link to="/sessions/s-1?m=long-say">follow permalink</Link> },
  )

  await tabsLoaded()
  const [top] = collapseButtons(articleOf(panelOf(), /LONGSAY/))
  if (top === undefined) throw new Error("no collapse button")
  await user.click(top)
  expect(collapseButtons(articleOf(panelOf(), /LONGSAY/))).toHaveLength(0)

  await user.click(screen.getByRole("link", { name: "follow permalink" }))

  expect(collapseButtons(articleOf(panelOf(), /LONGSAY/))).toHaveLength(2)
})

test("following a permalink to a second message merged into an already-linked, collapsed reply reopens it", async () => {
  const user = userEvent.setup()
  renderDetail(
    buildPayload({
      messages: [
        message({
          id: "say-1",
          lineNumber: 1,
          msgType: "message",
          role: "assistant",
          content: text(longText("FIRSTSAY")),
        }),
        message({
          id: "say-2",
          lineNumber: 2,
          msgType: "message",
          role: "assistant",
          content: text("SECONDSAY in the same run"),
        }),
      ],
    }),
    OK_EMPTY,
    "/sessions/s-1?m=say-1",
    { beside: <Link to="/sessions/s-1?m=say-2">follow second permalink</Link> },
  )

  await tabsLoaded()
  const [top] = collapseButtons(articleOf(panelOf(), /FIRSTSAY/))
  if (top === undefined) throw new Error("no collapse button")
  await user.click(top)
  expect(collapseButtons(articleOf(panelOf(), /SECONDSAY/))).toHaveLength(0)

  await user.click(screen.getByRole("link", { name: "follow second permalink" }))

  expect(collapseButtons(articleOf(panelOf(), /SECONDSAY/))).toHaveLength(2)
})

test("collapsing a long reply scrolled above the screen scrolls that reply's own record back to its start", async () => {
  const user = userEvent.setup()
  const scrolled = recordScrolls()
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, -500, 100, 100),
  )
  renderDetail(
    buildPayload({
      messages: [
        message({
          id: "long-say",
          lineNumber: 1,
          msgType: "message",
          role: "assistant",
          content: text(longText("LONGSAY")),
        }),
      ],
    }),
  )

  await tabsLoaded()
  const article = articleOf(panelOf(), /LONGSAY/)
  const [, bottom] = collapseButtons(article)
  if (bottom === undefined) throw new Error("no bottom collapse button")
  await user.click(bottom)

  expect(article.id).not.toBe("")
  expect(scrolled).toContainEqual({ id: article.id, block: "start" })
})
