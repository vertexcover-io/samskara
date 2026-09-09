import postgres from "postgres"
import { requireDatabaseUrl } from "./db.js"
import { expect, mintCliToken, test } from "./fixtures/auth.js"
import { API_BASE } from "./playwright.config.js"
import { type SeedSpec, seedDatabase } from "./seed.js"

// Exactly what a Claude Code before 2.1.23x writes for a task notification: an attachment line
// whose `commandMode` is the only thing marking it as one. A CLI old enough to emit this is also
// old enough not to set `subType` itself, so the payload below carries none.
const OLD_CLI_TASK_NOTIFICATION_RAW = {
  type: "attachment",
  attachment: {
    type: "queued_command",
    commandMode: "task-notification",
    prompt: "3 background jobs finished while you were away.",
  },
}

const SESSION_ID = "e2e-ingest-task-notification"
const NOTIFICATION_LINE = "0191d942-3ba5-7dba-9a7d-00000000e001"
const PROMPT_LINE = "0191d942-3ba5-7dba-9a7d-00000000e002"

const SEED: SeedSpec = {
  projects: [{ slug: "samskara", name: "Samskara", sessions: [] }],
}

const messageBase = {
  sessionId: SESSION_ID,
  source: "claude_code" as const,
  sourceSchemaVersion: 1,
  trackId: "main",
  subIndex: 0,
  msgType: "message" as const,
  role: "user" as const,
}

const payload = {
  type: "main",
  sessionId: SESSION_ID,
  sourceRelativePath: `${SESSION_ID}.jsonl`,
  project: { name: "Samskara", slug: "samskara" },
  records: [
    {
      lineUuid: NOTIFICATION_LINE,
      lineNumber: 1,
      raw: OLD_CLI_TASK_NOTIFICATION_RAW,
      messages: [
        {
          ...messageBase,
          content: { type: "text", value: "3 background jobs finished while you were away." },
        },
      ],
    },
    {
      lineUuid: PROMPT_LINE,
      lineNumber: 2,
      raw: { type: "text" },
      messages: [
        {
          ...messageBase,
          content: { type: "text", value: "Please add a retry to the upload job." },
        },
      ],
    },
  ],
}

const subTypesBySession = async (): Promise<ReadonlyArray<string | null>> => {
  const sql = postgres(requireDatabaseUrl(), { max: 1 })
  try {
    const rows = await sql<ReadonlyArray<{ subType: string | null }>>`
      select "subType" from messages
      where "sessionId" = ${SESSION_ID}
      order by "lineNumber"
    `
    return rows.map((row) => row.subType)
  } finally {
    await sql.end()
  }
}

test.beforeEach(async () => {
  await seedDatabase(SEED)
})

/**
 * The transformer runs inside `ingest()`, which the `POST /api/ingest` route calls. Every other
 * test reaches it below that line: the service test calls the function directly, and the repair
 * test seeds its row straight into the table. This is the only one that proves an old client can
 * upload over HTTP and have the correction reach the screen.
 */
test("SC14: an old CLI uploads a task notification and the server corrects it on the way in", async ({
  request,
  authedPage: page,
}) => {
  // The standalone `request` fixture, not `page.request`: the latter carries the browser session
  // cookie, and the route then authenticates as a signed-in user rather than as a CLI client.
  const response = await request.post(`${API_BASE}/api/ingest`, {
    headers: { authorization: `Bearer ${await mintCliToken()}` },
    data: payload,
  })

  expect(response.status()).toBe(200)
  expect(await response.json()).toMatchObject({ ingested: 2 })

  expect(await subTypesBySession()).toEqual(["taskNotification", null])

  await page.goto(`/sessions/${SESSION_ID}`)
  const conversation = page.getByRole("tabpanel", { name: /Conversation/ })

  await expect(conversation.getByText("Task Notification")).toBeVisible()
  await expect(conversation.getByText("Please add a retry to the upload job.")).toBeVisible()

  // One occurrence: the prompt they typed. Never the notification.
  await expect(conversation.getByText("e2e-user", { exact: true })).toHaveCount(1)
})
