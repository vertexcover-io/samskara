import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, test, vi } from "vitest"
import { AppRoutes } from "../App.js"
import type { CurrentUser } from "../api/types.js"
import { TestRouter } from "../tests/test-router.js"

const user: CurrentUser = {
  id: "u-1",
  githubLogin: "e2e-user",
  email: "e2e@example.com",
  name: "E2E User",
  avatarUrl: null,
  isSuperAdmin: false,
}

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const stubFetch = (logout: () => Promise<Response>): void => {
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    const path = typeof input === "string" ? input : input.toString()
    if (path.endsWith("/api/auth/me")) return Promise.resolve(jsonResponse(200, user))
    if (path.endsWith("/api/projects")) return Promise.resolve(jsonResponse(200, { projects: [] }))
    if (path.endsWith("/api/auth/logout")) return logout()
    return Promise.reject(new Error(`unstubbed fetch: ${path}`))
  })
}

const renderProjects = () =>
  render(
    <TestRouter initialEntries={["/projects"]}>
      <AppRoutes />
    </TestRouter>,
  )

const openMenu = async (): Promise<void> => {
  const trigger = await screen.findByRole("button", { name: /account menu/i })
  await userEvent.click(trigger)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

test("S28: the opened account menu lists the signed-in identity plus 'Pair the CLI' and 'Log out' - not just a bare identity label", async () => {
  stubFetch(() => Promise.resolve(jsonResponse(200, { ok: true })))

  renderProjects()
  await openMenu()

  const menu = screen.getByRole("menu")
  expect(menu).toHaveTextContent("e2e-user")
  expect(screen.getByRole("menuitem", { name: /pair the cli/i })).toBeInTheDocument()
  expect(screen.getByRole("menuitem", { name: /log out/i })).toBeInTheDocument()
})

test("S34: a 200 from /api/auth/logout lands on /login in the signed-out shell - no identity, no account menu, the GitHub sign-in link back", async () => {
  stubFetch(() => Promise.resolve(jsonResponse(200, { ok: true })))

  renderProjects()
  await openMenu()
  await userEvent.click(screen.getByRole("menuitem", { name: /log out/i }))

  await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/login"))
  expect(await screen.findByRole("link", { name: /continue with github/i })).toBeInTheDocument()
  expect(screen.queryByText("e2e-user")).not.toBeInTheDocument()
  expect(screen.queryByRole("button", { name: /account menu/i })).not.toBeInTheDocument()
})

test("S35: a failed /api/auth/logout keeps the user on /projects with the identity still rendered - not an optimistic sign-out", async () => {
  stubFetch(() => Promise.resolve(jsonResponse(500, { error: "boom" })))

  renderProjects()
  await openMenu()
  await userEvent.click(screen.getByRole("menuitem", { name: /log out/i }))

  expect(await screen.findByRole("alert")).toHaveTextContent(/server responded with 500/i)
  expect(screen.getByTestId("location")).toHaveTextContent("/projects")
  expect(screen.getByRole("button", { name: /account menu/i })).toHaveTextContent("e2e-user")
})

test("S28b: Escape closes the open menu and returns focus to the trigger - not to the document body", async () => {
  stubFetch(() => Promise.resolve(jsonResponse(200, { ok: true })))

  renderProjects()
  await openMenu()
  const trigger = screen.getByRole("button", { name: /account menu/i })

  await userEvent.keyboard("{Escape}")

  expect(screen.queryByRole("menu")).not.toBeInTheDocument()
  expect(trigger).toHaveFocus()
})

test("S28c: opening the menu moves focus onto the first menu item - not leaving it stranded on the trigger", async () => {
  stubFetch(() => Promise.resolve(jsonResponse(200, { ok: true })))

  renderProjects()
  await openMenu()

  await waitFor(() => expect(screen.getByRole("menuitem", { name: /pair the cli/i })).toHaveFocus())
})

test.each([
  {
    name: "S28d: ArrowDown and ArrowUp cycle through the menu items and wrap",
    steps: [
      ["{ArrowDown}", /log out/i],
      ["{ArrowDown}", /pair the cli/i],
      ["{ArrowUp}", /log out/i],
    ],
  },
  {
    name: "S28e: End and Home jump to the last and first menu items",
    steps: [
      ["{End}", /log out/i],
      ["{Home}", /pair the cli/i],
    ],
  },
] satisfies ReadonlyArray<{ name: string; steps: ReadonlyArray<readonly [string, RegExp]> }>)(
  "$name - not leaving focus where it was",
  async ({ steps }) => {
    stubFetch(() => Promise.resolve(jsonResponse(200, { ok: true })))

    renderProjects()
    await openMenu()
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: /pair the cli/i })).toHaveFocus(),
    )

    for (const [key, focused] of steps) {
      await userEvent.keyboard(key)
      expect(screen.getByRole("menuitem", { name: focused })).toHaveFocus()
    }
  },
)

test("S28f: closing the pairing dialog opened from the menu returns focus to the account menu trigger - not to the document body", async () => {
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    const path = typeof input === "string" ? input : input.toString()
    if (path.endsWith("/api/auth/me")) return Promise.resolve(jsonResponse(200, user))
    if (path.endsWith("/api/projects")) return Promise.resolve(jsonResponse(200, { projects: [] }))
    if (path.endsWith("/api/auth/cli-code")) return new Promise<Response>(() => {})
    return Promise.reject(new Error(`unstubbed fetch: ${path}`))
  })

  renderProjects()
  await openMenu()
  await userEvent.click(screen.getByRole("menuitem", { name: /pair the cli/i }))

  const dialog = await screen.findByRole("dialog", { name: "Pair the CLI" })
  expect(dialog).toBeInTheDocument()

  await userEvent.keyboard("{Escape}")

  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
  expect(screen.getByRole("button", { name: /account menu/i })).toHaveFocus()
})
