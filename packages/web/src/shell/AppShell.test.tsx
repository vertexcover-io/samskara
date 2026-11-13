import { render, screen, within } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"
import { TestRouter } from "../tests/test-router.js"
import { AppShell } from "./AppShell.js"

afterEach(() => {
  vi.restoreAllMocks()
})

test("SC704: the top bar offers Projects, Sessions, Compound learning evaluation, Orgs and Sync, and no Fixes", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          id: "u-1",
          githubLogin: "dev",
          email: "dev@example.com",
          name: "Dev",
          avatarUrl: null,
          isSuperAdmin: false,
        }),
        { status: 200 },
      ),
    ),
  )

  render(
    <TestRouter initialEntries={["/projects"]}>
      <AppShell>
        <p>page</p>
      </AppShell>
    </TestRouter>,
  )

  const nav = await screen.findByRole("navigation", { name: "Primary" })
  expect(
    within(nav)
      .getAllByRole("link")
      .map((link) => link.textContent),
  ).toEqual(["Projects", "Sessions", "Compound learning evaluation", "Orgs", "Sync"])
  expect(within(nav).queryByRole("link", { name: "Fixes" })).toBeNull()
})
