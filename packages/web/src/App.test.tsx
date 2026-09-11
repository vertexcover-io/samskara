import { render, screen, waitFor, waitForElementToBeRemoved, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, test, vi } from "vitest"
import { AppRoutes } from "./App.js"
import type { CurrentUser, ProjectSummary } from "./api/types.js"
import { TestRouter } from "./tests/test-router.js"

const user: CurrentUser = {
  id: "u-1",
  githubLogin: "e2e-user",
  email: "e2e@example.com",
  name: "E2E User",
  avatarUrl: null,
  isSuperAdmin: false,
}

const samskara: ProjectSummary = {
  id: "p-1",
  name: "Samskara",
  slug: "samskara",
  owner: { type: "user", slug: "e2e-user" },
  sessionCount: 3,
  lastActiveAt: "2026-02-01T09:30:00.000Z",
  repo: null,
}

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })

type Routes = {
  readonly me: () => Promise<Response>
  readonly projects?: () => Promise<Response>
}

const stubFetch = (routes: Routes): void => {
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    const path = typeof input === "string" ? input : input.toString()
    if (path.endsWith("/api/auth/me")) return routes.me()
    if (path.endsWith("/api/projects")) {
      return routes.projects?.() ?? Promise.resolve(jsonResponse(200, { projects: [] }))
    }
    return Promise.reject(new Error(`unstubbed fetch: ${path}`))
  })
}

const renderAt = (path: string) =>
  render(
    <TestRouter initialEntries={[path]}>
      <AppRoutes />
    </TestRouter>,
  )

afterEach(() => {
  vi.unstubAllGlobals()
})

test("S9: while /api/auth/me is unresolved a status element shows and neither Login nor project data is in the DOM", () => {
  stubFetch({ me: () => new Promise<Response>(() => {}) })

  renderAt("/projects")

  expect(screen.getByRole("status")).toBeInTheDocument()
  expect(screen.queryByRole("link", { name: /continue with github/i })).not.toBeInTheDocument()
  expect(screen.queryByText("Samskara")).not.toBeInTheDocument()
})

test("S10: an anonymous visit to /projects ends at /login showing the GitHub link - not a blank protected shell", async () => {
  stubFetch({ me: () => Promise.resolve(jsonResponse(401, { error: "unauthorized" })) })

  renderAt("/projects")

  expect(await screen.findByRole("link", { name: /continue with github/i })).toBeInTheDocument()
  expect(screen.getByTestId("location")).toHaveTextContent("/login")
})

test("S11: an authenticated visit to /login lands on /projects instead of showing the sign-in screen again", async () => {
  stubFetch({ me: () => Promise.resolve(jsonResponse(200, user)) })

  renderAt("/login")

  await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/projects"))
  expect(screen.queryByRole("link", { name: /continue with github/i })).not.toBeInTheDocument()
})

test("S12: an empty project list renders CLI-capture guidance and no grid - not a bare blank panel", async () => {
  stubFetch({
    me: () => Promise.resolve(jsonResponse(200, user)),
    projects: () => Promise.resolve(jsonResponse(200, { projects: [] })),
  })

  renderAt("/projects")

  expect(await screen.findByText("samskara capture")).toBeInTheDocument()
  expect(screen.getByText(/send your first capture from the cli/i)).toBeInTheDocument()
  expect(screen.queryByRole("list")).not.toBeInTheDocument()
  // Scoped to main: the shell's own wordmark links to /projects and is not a project card.
  const main = within(screen.getByRole("main"))
  expect(main.queryByRole("link", { name: /samskara(?! capture)/i })).not.toBeInTheDocument()
})

test("SC10: the projects page renders one card for each project the API returns", async () => {
  const andromeda: ProjectSummary = {
    id: "p-2",
    name: "Andromeda",
    slug: "andromeda",
    owner: { type: "user", slug: "e2e-user" },
    sessionCount: 0,
    lastActiveAt: null,
    repo: null,
  }
  stubFetch({
    me: () => Promise.resolve(jsonResponse(200, user)),
    projects: () => Promise.resolve(jsonResponse(200, { projects: [samskara, andromeda] })),
  })

  renderAt("/projects")

  // The shell paints `main` before the request settles, so waiting on that role lands on the
  // loading state. Wait for loading to end instead.
  await waitForElementToBeRemoved(() => screen.queryByTestId("loading"))
  const main = within(screen.getByRole("main"))
  expect(main.getByText("Samskara")).toBeInTheDocument()
  expect(main.getByText("Andromeda")).toBeInTheDocument()
  expect(main.getByText("3")).toBeInTheDocument()
  expect(main.getByText(/unavailable/i)).toBeInTheDocument()
})

test("SC11: a 401 on the projects page redirects to /login rather than painting an empty shelf", async () => {
  stubFetch({
    me: () => Promise.resolve(jsonResponse(200, user)),
    projects: () => Promise.resolve(jsonResponse(401, { error: "unauthorized" })),
  })

  renderAt("/projects")

  await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/login"))
  expect(screen.queryByText(/no projects yet/i)).not.toBeInTheDocument()
})

test("S10: a session that expires after /api/auth/me resolved lands on /login and stops requesting - it does not ping-pong between /login and /projects forever", async () => {
  const calls: Array<string> = []
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    const path = typeof input === "string" ? input : input.toString()
    calls.push(path)
    if (path.endsWith("/api/auth/me")) return Promise.resolve(jsonResponse(200, user))
    return Promise.resolve(jsonResponse(401, { error: "unauthorized" }))
  })

  renderAt("/sessions?user=maya")

  expect(await screen.findByRole("link", { name: /continue with github/i })).toBeInTheDocument()
  expect(screen.getByTestId("location")).toHaveTextContent("/login")

  const settled = calls.length
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(calls.length).toBe(settled)
  expect(calls.filter((path) => path.endsWith("/api/projects")).length).toBeLessThanOrEqual(1)
})

test("SC7: activating the samskara card navigates to its project page with the project id encoded", async () => {
  stubFetch({
    me: () => Promise.resolve(jsonResponse(200, user)),
    projects: () => Promise.resolve(jsonResponse(200, { projects: [samskara] })),
  })

  renderAt("/projects")

  const main = await screen.findByRole("main")
  const card = await within(main).findByRole("link", { name: /samskara/i })
  await userEvent.click(card)

  expect(screen.getByTestId("location")).toHaveTextContent("/projects/p-1")
})
