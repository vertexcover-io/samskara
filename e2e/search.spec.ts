import { expect, test } from "./fixtures/auth.js"
import { type SeedSpec, seedDatabase } from "./seed.js"

const SEED: SeedSpec = {
  projects: [
    {
      slug: "samskara",
      name: "Samskara",
      sessions: [
        {
          id: "e2e-search-1",
          title: "Debug the payment timeout",
          messages: [
            {
              msgType: "message",
              role: "user",
              content: {
                type: "text",
                value: "The checkout keeps failing with a network timeout.",
              },
            },
          ],
        },
        {
          id: "e2e-search-2",
          title: "Refactor the onboarding flow",
          messages: [
            {
              msgType: "message",
              role: "user",
              content: { type: "text", value: "Simplify the onboarding wizard steps." },
            },
          ],
        },
        {
          id: "e2e-search-3",
          title: "Patch the ingest watcher",
          messages: [
            {
              msgType: "toolCall",
              details: {
                name: "Edit",
                input: { file_path: "packages/server/src/ingest/watcher.ts" },
              },
            },
          ],
        },
      ],
    },
  ],
}

const titles = [
  "Debug the payment timeout",
  "Refactor the onboarding flow",
  "Patch the ingest watcher",
]

test.beforeEach(async () => {
  await seedDatabase(SEED)
})

test("SC25: a typed keyword narrows the list, and reloading the URL reproduces it", async ({
  authedPage: page,
}) => {
  await page.goto("/sessions")

  for (const title of titles) {
    await expect(page.getByRole("link", { name: new RegExp(title) })).toBeVisible()
  }

  await page.getByRole("searchbox", { name: /keyword/i }).fill("timeout")

  await expect(page).toHaveURL(/[?&]q=timeout(&|$)/)
  await expect(page.getByRole("link", { name: /Debug the payment timeout/ })).toBeVisible()
  await expect(page.getByRole("link", { name: /Refactor the onboarding flow/ })).toHaveCount(0)
  await expect(page.getByRole("link", { name: /Patch the ingest watcher/ })).toHaveCount(0)

  await page.reload()

  await expect(page.getByRole("searchbox", { name: /keyword/i })).toHaveValue("timeout")
  await expect(page.getByRole("link", { name: /Debug the payment timeout/ })).toBeVisible()
  await expect(page.getByRole("link", { name: /Refactor the onboarding flow/ })).toHaveCount(0)
  await expect(page.getByRole("link", { name: /Patch the ingest watcher/ })).toHaveCount(0)
})

test("SC26: clearing the keyword after a narrowing search restores the full list", async ({
  authedPage: page,
}) => {
  await page.goto("/sessions?q=timeout")

  await expect(page.getByRole("link", { name: /Debug the payment timeout/ })).toBeVisible()
  await expect(page.getByRole("link", { name: /Refactor the onboarding flow/ })).toHaveCount(0)

  await page.getByRole("searchbox", { name: /keyword/i }).fill("")

  await expect(page).not.toHaveURL(/[?&]q=/)
  for (const title of titles) {
    await expect(page.getByRole("link", { name: new RegExp(title) })).toBeVisible()
  }
})
