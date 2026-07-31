import { expect, test } from "./fixtures/auth.js"
import { type SeedSpec, seedDatabase } from "./seed.js"

const SEED: SeedSpec = {
  projects: [
    {
      slug: "samskara",
      name: "Samskara",
      sessions: [
        {
          id: "e2e-detail-1",
          title: "Make ingest idempotent",
          subagents: [
            {
              agentId: "agent-audit",
              agentType: "db-schema-auditor",
              description: "Audit unique constraints across the ingest tables",
            },
          ],
          messages: [
            {
              msgType: "message",
              role: "user",
              content: { text: "Rescans duplicate rows - make ingest idempotent." },
              tokens: { input: 1200, output: 0 },
            },
            {
              msgType: "message",
              role: "assistant",
              content: [
                { type: "thinking", thinking: "Duplicates mean ingest lacks a natural key." },
                { type: "text", text: "Plan: add a unique key, then switch inserts to upserts." },
              ],
              tokens: { input: 0, output: 940 },
            },
            {
              msgType: "toolCall",
              tool: {
                toolId: "tool-grep-1",
                toolName: "Grep",
                toolInput: { pattern: "INSERT INTO sessions" },
                result: { matches: ["src/ingest.ts:142"] },
                status: "success",
              },
            },
            { msgType: "turnEvent", subType: "agentSpawn", agentId: "agent-audit" },
            {
              msgType: "message",
              role: "assistant",
              agentId: "agent-audit",
              isSubagent: true,
              content: { text: "No unique constraints exist on the three ingest tables." },
            },
            { msgType: "turnEvent", subType: "agentReturn", agentId: "agent-audit" },
            {
              msgType: "fileEvent",
              details: {
                type: "artifact",
                path: "migrations/0007_add_source_uid.sql",
                title: "Idempotency migration",
              },
            },
          ],
        },
        { id: "e2e-detail-2", title: "Wire the auth guard" },
      ],
    },
  ],
}

test.beforeEach(async () => {
  await seedDatabase(SEED)
})

test("S44: opening a session from the filtered list shows three tabs with Conversation selected, the inline-tools toggle reveals tool calls, the annex reveals its branch, Escape restores focus to the trigger, and Artifacts renders its viewer", async ({
  authedPage: page,
}) => {
  await page.goto("/sessions?project=samskara")
  await page.getByRole("button", { name: /Make ingest idempotent/ }).click()

  await expect(page).toHaveURL(/\/sessions\/e2e-detail-1$/)

  const tabs = page.getByRole("tab")
  await expect(tabs).toHaveCount(3)
  await expect(tabs).toHaveText([/Conversation/, /Tool Calls/, /Artifacts/])
  await expect(page.getByRole("tab", { name: /Conversation/ })).toHaveAttribute(
    "aria-selected",
    "true",
  )

  await expect(page.getByText(/Rescans duplicate rows/)).toBeVisible()
  await expect(page.getByText(/Plan: add a unique key/)).toBeVisible()
  await expect(page.getByRole("button", { name: /Grep/ })).toHaveCount(0)

  // click(), not check(): the toggle is controlled by the `tools` search param, so the remount
  // makes check()'s own state assertion race the re-render. The Grep assertion is the proof.
  await page.getByRole("checkbox", { name: /show tool calls inline/i }).click()
  await expect(page).toHaveURL(/tools=1/)
  await expect(page.getByRole("button", { name: /Grep/ }).first()).toBeVisible()

  const collapsed = page.getByRole("button", { name: /open branch/i })
  await expect(collapsed).toHaveAttribute("aria-expanded", "false")
  await collapsed.click()

  const expanded = page.getByRole("button", { name: /close branch/i })
  await expect(expanded).toHaveAttribute("aria-expanded", "true")
  await expect(collapsed).toHaveCount(0)
  const branch = page.getByRole("region", { name: /db-schema-auditor conversation/i })
  await expect(branch).toBeVisible()
  await expect(branch.getByText(/No unique constraints exist/)).toBeVisible()

  await page.getByRole("tab", { name: /Conversation/ }).focus()
  await page.keyboard.press("Escape")

  await expect(collapsed).toHaveAttribute("aria-expanded", "false")
  await expect(branch).toHaveCount(0)
  await expect(collapsed).toBeFocused()

  await page.getByRole("tab", { name: /Artifacts/ }).click()

  // This seeded session has no captured files, so the sole exhibit is its transcript frame-link --
  // proof the demo fixtures are gone and that frame-links still render on their own.
  const list = page.getByRole("list", { name: /filed artifacts/i })
  // One file, shown as a leaf under its `migrations` folder row -- so two buttons, one of which
  // is the expandable folder.
  await expect(list.getByRole("button", { name: /^migrations$/ })).toHaveCount(1)
  await expect(list.getByRole("button", { name: /0007_add_source_uid\.sql/ })).toHaveCount(1)
  const viewer = page.getByRole("region", { name: /artifact viewer/i })
  await expect(viewer.getByText("migrations/0007_add_source_uid.sql")).toBeVisible()
})

test("S44: the session masthead reports its six facts, and 320px introduces no horizontal scroll on the detail route", async ({
  authedPage: page,
}) => {
  await page.goto("/sessions/e2e-detail-1")

  const facts = page.getByRole("group", { name: /session facts/i })
  for (const label of [
    "Duration",
    "Messages",
    "Tool calls",
    "Subagents",
    "Tokens in",
    "Tokens out",
  ]) {
    await expect(facts.getByText(label, { exact: true })).toBeVisible()
  }
  await expect(facts.getByText("1,200")).toBeVisible()
  await expect(facts.getByText("940")).toBeVisible()

  await page.setViewportSize({ width: 320, height: 800 })
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  expect(overflow).toBeLessThanOrEqual(0)

  await page.getByRole("tab", { name: /Artifacts/ }).click()
  await expect(page.getByRole("combobox", { name: /choose an artifact/i })).toBeVisible()
  await expect(page.getByRole("list", { name: /filed artifacts/i })).toBeHidden()
})

test("EDGE-008 S44: a session id that does not exist renders the not-found state and its recovery returns to the list", async ({
  authedPage: page,
}) => {
  await page.goto("/sessions/no-such-session")

  await expect(page.getByText(/no such session/i)).toBeVisible()
  await expect(page.getByRole("tab")).toHaveCount(0)

  await page.getByRole("button", { name: /back to all sessions/i }).click()

  await expect(page).toHaveURL(/\/sessions$/)
  await expect(page.getByRole("button", { name: /Make ingest idempotent/ })).toBeVisible()
})
