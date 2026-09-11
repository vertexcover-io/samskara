import { readFileSync } from "node:fs"
import postgres from "postgres"
import { requireDatabaseUrl } from "./db.js"
import { expect, test } from "./fixtures/auth.js"
import { projectId, type SeedSpec, seedDatabase } from "./seed.js"

// The row this seeds mirrors what an older CLI stored before the server corrected arriving
// messages: `subType` never set, with the transcript line preserved in `raw`. The migration this
// phase adds is what a deploy runs once against rows already in this shape.
const OLD_CLI_TASK_NOTIFICATION_RAW = {
  type: "attachment",
  attachment: {
    type: "queued_command",
    commandMode: "task-notification",
    prompt: "3 background jobs finished while you were away.",
  },
}

const SEED: SeedSpec = {
  projects: [
    {
      slug: "samskara",
      name: "Samskara",
      sessions: [
        {
          id: "e2e-task-notification-repair",
          title: "Session holding a repaired notification row",
          messages: [
            {
              msgType: "message",
              role: "user",
              content: { type: "text", value: "Please add a retry to the upload job." },
            },
            {
              msgType: "message",
              role: "user",
              content: {
                type: "text",
                value: "3 background jobs finished while you were away.",
              },
              raw: OLD_CLI_TASK_NOTIFICATION_RAW,
            },
          ],
        },
      ],
    },
  ],
}

const runRepairMigration = async (): Promise<void> => {
  const migration = readFileSync(
    new URL("../packages/server/migrations/0026_task_notification_subtype.sql", import.meta.url),
    "utf8",
  )
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)

  const sql = postgres(requireDatabaseUrl(), { max: 1 })
  try {
    for (const statement of migration) await sql.unsafe(statement)
  } finally {
    await sql.end()
  }
}

test.beforeEach(async () => {
  await seedDatabase(SEED)
  // The suite's own `migrateTo` already ran 0026 before any row existed to repair. Running it
  // again here, against a row seeded in the pre-repair shape, is what "the repair has run"
  // means for a row already in the database at deploy time.
  await runRepairMigration()
})

test("SC13: a stored task notification reads as a task notification, not as something the owner said", async ({
  authedPage: page,
}) => {
  await page.goto(`/sessions?project=${projectId("samskara")}`)
  await page.getByRole("link", { name: /Session holding a repaired notification row/ }).click()
  await expect(page).toHaveURL(/\/sessions\/e2e-task-notification-repair$/)

  const conversation = page.getByRole("tabpanel", { name: /Conversation/ })
  await expect(
    conversation.getByText(/3 background jobs finished while you were away/).first(),
  ).toBeVisible()
  await expect(conversation.getByText("Task Notification")).toBeVisible()
  await expect(conversation.getByText("Please add a retry to the upload job.")).toBeVisible()

  // The owner's login is the actor on the genuine prompt alone: one occurrence in the
  // conversation timeline, never on the record repaired by this phase's migration.
  await expect(conversation.getByText("e2e-user", { exact: true })).toHaveCount(1)
})
