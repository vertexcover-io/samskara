import { SignJWT } from "jose"
import postgres from "postgres"
import { expect, test } from "./fixtures/auth.js"
import { API_BASE } from "./playwright.config.js"
import { E2E_OTHER_USER_ID, E2E_USER_ID, seedDatabase } from "./seed.js"

const JWT_SECRET = process.env.JWT_SECRET ?? "e2e-secret"
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://samskara:samskara@localhost:5433/samskara"

const mintCliToken = (subject: string): Promise<string> =>
  new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("samskara")
    .setAudience("cli")
    .setSubject(subject)
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(JWT_SECRET))

const postIngest = async (payload: unknown, subject: string): Promise<void> => {
  const res = await fetch(`${API_BASE}/api/ingest`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${await mintCliToken(subject)}`,
    },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    throw new Error(`ingest failed (${res.status}): ${await res.text()}`)
  }
}

// One record, one message: the shape every ingest fixture below builds from.
const record = (lineNumber: number, message: Record<string, unknown>) => ({
  lineUuid: crypto.randomUUID(),
  lineNumber,
  raw: {},
  messages: [message],
})

// A subagent payload's superRefine requires every message's `agentId` to equal the payload's own
// agent and `trackId` to be `agent:<agentId>` -- `agentId` is passed only for those messages.
const userMsg = (sessionId: string, text: string, trackId = "main", agentId?: string) => ({
  subIndex: 0,
  sessionId,
  source: "claude_code",
  sourceSchemaVersion: 1,
  trackId,
  msgType: "message",
  role: "user",
  content: { type: "text", value: text },
  ...(agentId === undefined ? {} : { agentId }),
})

const assistantMsg = (sessionId: string, text: string, trackId = "main", agentId?: string) => ({
  subIndex: 0,
  sessionId,
  source: "claude_code",
  sourceSchemaVersion: 1,
  trackId,
  msgType: "message",
  role: "assistant",
  content: { type: "text", value: text },
  ...(agentId === undefined ? {} : { agentId }),
})

const toolCallMsg = (sessionId: string, callId: string, name: string, input: unknown) => ({
  subIndex: 0,
  sessionId,
  source: "claude_code",
  sourceSchemaVersion: 1,
  trackId: "main",
  msgType: "toolCall",
  details: { callId, name, input },
})

const toolResultMsg = (sessionId: string, callId: string, output: unknown) => ({
  subIndex: 0,
  sessionId,
  source: "claude_code",
  sourceSchemaVersion: 1,
  trackId: "main",
  msgType: "toolResult",
  details: { callId, output, status: "success" },
})

const SESSION_IDS = [
  "e2e-search-main",
  "e2e-search-subagent",
  "e2e-search-accept",
  "e2e-search-stranger",
]
const PROJECT_SLUGS = ["e2e-search-proj", "e2e-search-accept-proj", "e2e-search-stranger-proj"]

// Rows created via real ingest POSTs, not `seedDatabase` -- cleared by id/slug rather than by
// owner, since the stranger's project is owned by E2E_OTHER_USER_ID.
const clearIngestedRows = async (): Promise<void> => {
  const sql = postgres(DATABASE_URL)
  try {
    await sql`delete from sessions where id = any(${SESSION_IDS})`
    await sql`delete from projects where slug = any(${PROJECT_SLUGS})`
  } finally {
    await sql.end()
  }
}

test.beforeEach(async () => {
  // Guarantees both e2e users exist and clears any state a previous spec left for them.
  await seedDatabase({ projects: [] })
  await clearIngestedRows()
})

test.describe("in-session search (D22)", () => {
  test.beforeEach(async () => {
    // Main track: a closed turn whose tool result carries a word that appears nowhere else.
    await postIngest(
      {
        type: "main",
        sessionId: "e2e-search-main",
        sourceRelativePath: "e2e-search-main.jsonl",
        project: { name: "e2e-search-proj", slug: "e2e-search-proj" },
        title: "Investigate the checkout crash",
        records: [
          record(1, userMsg("e2e-search-main", "Investigate the checkout crash")),
          record(2, assistantMsg("e2e-search-main", "Looking into the checkout flow now")),
          record(
            3,
            toolCallMsg("e2e-search-main", "call-1", "Bash", { command: "grep -r checkout" }),
          ),
          record(
            4,
            toolResultMsg(
              "e2e-search-main",
              "call-1",
              "gribblewomp: root cause found in checkout.ts:42",
            ),
          ),
          record(5, userMsg("e2e-search-main", "thanks, ship it")),
        ],
      },
      E2E_USER_ID,
    )

    // A subagent track on the same session: the parent track's "Agent" tool call is what
    // records.ts pairs with the subagent to synthesise the branch's spawn marker -- capture does
    // not always emit a dedicated spawn event, so this is the real mechanism, not a shortcut.
    await postIngest(
      {
        type: "main",
        sessionId: "e2e-search-subagent",
        sourceRelativePath: "e2e-search-subagent.jsonl",
        project: { name: "e2e-search-proj", slug: "e2e-search-proj" },
        title: "Chase the flaky test",
        records: [
          record(1, userMsg("e2e-search-subagent", "Research the flaky test failure")),
          record(
            2,
            toolCallMsg("e2e-search-subagent", "call-agent-1", "Agent", {
              description: "Chase the flaky test",
            }),
          ),
          record(3, userMsg("e2e-search-subagent", "thanks")),
        ],
      },
      E2E_USER_ID,
    )
    await postIngest(
      {
        type: "subagent",
        sessionId: "e2e-search-subagent",
        sourceRelativePath: "e2e-search-subagent/subagents/agent-flaky.jsonl",
        project: { name: "e2e-search-proj", slug: "e2e-search-proj" },
        agent: { agentId: "agent-flaky", agentType: "investigator", description: "Chase it" },
        records: [
          record(
            1,
            userMsg(
              "e2e-search-subagent",
              "Investigate the flaky test failure",
              "agent:agent-flaky",
              "agent-flaky",
            ),
          ),
          record(
            2,
            assistantMsg(
              "e2e-search-subagent",
              "Found it: flumberjack timeout in the retry logic",
              "agent:agent-flaky",
              "agent-flaky",
            ),
          ),
          record(
            3,
            userMsg("e2e-search-subagent", "any more detail?", "agent:agent-flaky", "agent-flaky"),
          ),
        ],
      },
      E2E_USER_ID,
    )
  })

  test("searching inside a seeded multi-turn session and clicking a result moves the conversation to that message", async ({
    authedPage: page,
  }) => {
    await page.goto("/sessions/e2e-search-main")
    // The masthead's <h1> and the transcript's opening prompt both carry this exact text.
    await expect(
      page.getByRole("tabpanel").getByText(/Investigate the checkout crash/),
    ).toBeVisible()

    await page.getByRole("searchbox", { name: /search this session/i }).fill("gribblewomp")
    await page.getByRole("button", { name: /^search$/i }).click()

    const results = page.getByRole("list", { name: /search results/i })
    const result = results.getByRole("button", { name: /gribblewomp/i })
    await expect(result).toBeVisible()
    await result.click()

    await expect(page).toHaveURL(/[?&]m=/)
    const marked = page.locator('[aria-current="location"]')
    await expect(marked).toContainText(/Investigate the checkout crash/)
  })

  test("a result whose anchor is inside a subagent track opens that branch and anchors correctly", async ({
    authedPage: page,
  }) => {
    await page.goto("/sessions/e2e-search-subagent")
    await expect(page.getByText(/Research the flaky test failure/)).toBeVisible()

    await page.getByRole("searchbox", { name: /search this session/i }).fill("flumberjack")
    await page.getByRole("button", { name: /^search$/i }).click()

    const results = page.getByRole("list", { name: /search results/i })
    const result = results.getByRole("button", { name: /flumberjack/i })
    await expect(result).toBeVisible()
    await result.click()

    const branch = page.getByRole("region", { name: /investigator conversation/i })
    await expect(branch).toBeVisible()
    await expect(branch).toContainText(/Found it: flumberjack timeout/)
    // The chunk's anchor is the turn's opening message (D7), not the line the matched word is on.
    const marked = branch.locator('[aria-current="location"]')
    await expect(marked).toContainText(/Investigate the flaky test failure/)
  })
})

test.describe("session search acceptance (plan ## Acceptance)", () => {
  test.beforeEach(async () => {
    // The primary user's session: the word lives only in a tool result.
    await postIngest(
      {
        type: "main",
        sessionId: "e2e-search-accept",
        sourceRelativePath: "e2e-search-accept.jsonl",
        project: { name: "e2e-search-accept-proj", slug: "e2e-search-accept-proj" },
        title: "Deploy pipeline investigation",
        records: [
          record(1, userMsg("e2e-search-accept", "Investigate the deploy pipeline")),
          record(2, assistantMsg("e2e-search-accept", "Checking the pipeline logs")),
          record(
            3,
            toolCallMsg("e2e-search-accept", "call-1", "Bash", { command: "tail deploy.log" }),
          ),
          record(
            4,
            toolResultMsg("e2e-search-accept", "call-1", "zephyrquark17: stage failed at rollout"),
          ),
          record(5, userMsg("e2e-search-accept", "great, done")),
        ],
      },
      E2E_USER_ID,
    )

    // A stranger's session, owned by a different user with no grant to the primary user, that
    // matches the same word far more strongly -- proving privacy rather than mere weak ranking.
    await postIngest(
      {
        type: "main",
        sessionId: "e2e-search-stranger",
        sourceRelativePath: "e2e-search-stranger.jsonl",
        project: { name: "e2e-search-stranger-proj", slug: "e2e-search-stranger-proj" },
        title: "Stranger's private deploy notes",
        records: [
          record(
            1,
            userMsg(
              "e2e-search-stranger",
              "zephyrquark17 zephyrquark17 zephyrquark17 zephyrquark17",
            ),
          ),
          record(2, userMsg("e2e-search-stranger", "closing this out")),
        ],
      },
      E2E_OTHER_USER_ID,
    )
  })

  test("a session ingested through the real pipeline is findable from the sessions page, opens anchored on its matching turn, and the same query inside it returns the same turn -- while a stranger's session never appears", async ({
    authedPage: page,
  }) => {
    // 1. Findable from the sessions page by a word appearing only in a tool result.
    await page.goto("/sessions")
    await page.getByRole("searchbox", { name: /^search$/i }).fill("zephyrquark17")

    // The unfiltered list already shows this row; wait for the *ranked* response (its snippet is
    // only ever present on a `?q=` result) before clicking, or the row still carries no anchor.
    const row = page.getByRole("button", { name: /deploy pipeline investigation/i })
    await expect(row.getByTestId("session-snippet")).toBeVisible()
    await expect(
      page.getByRole("button", { name: /stranger's private deploy notes/i }),
    ).toHaveCount(0)

    await row.click()
    await expect(page).toHaveURL(/\/sessions\/e2e-search-accept\?m=/)
    const marked = page.locator('[aria-current="location"]')
    await expect(marked).toContainText(/Investigate the deploy pipeline/)

    // 2. The same query, typed inside that session, returns the same turn without leaving the page.
    await page.getByRole("searchbox", { name: /search this session/i }).fill("zephyrquark17")
    await page.getByRole("button", { name: /^search$/i }).click()

    const results = page.getByRole("list", { name: /search results/i })
    await expect(results.getByRole("button", { name: /zephyrquark17/i })).toBeVisible()
    await expect(page).toHaveURL(/\/sessions\/e2e-search-accept/)
  })
})
