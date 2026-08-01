import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, test, vi } from "vitest"
import { AppRoutes } from "../App.js"
import type { CurrentUser, SessionSummary } from "../api/types.js"
import { TestRouter } from "../tests/test-router.js"

const user: CurrentUser = {
  id: "u-1",
  githubLogin: "e2e-user",
  email: "e2e@example.com",
  name: "E2E User",
  avatarUrl: null,
}

const session: SessionSummary = {
  id: "s-1",
  title: "Port the session detail surface",
  projectName: "Samskara",
  projectSlug: "samskara",
  userLogin: "maya",
  repo: null,
  durationMs: 900_000,
  tokensTotal: 4200,
  status: "complete",
  lastActiveAt: "2026-02-01T09:30:00.000Z",
}

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

type SessionsHandler = (url: URL) => Promise<Response>

const stubFetch = (sessions: SessionsHandler): ReadonlyArray<string> => {
  const calls: Array<string> = []
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    const path = typeof input === "string" ? input : input.toString()
    if (path.endsWith("/api/auth/me")) return Promise.resolve(jsonResponse(200, user))
    if (path.startsWith("/api/sessions")) {
      calls.push(path)
      return sessions(new URL(path, "http://localhost"))
    }
    return Promise.reject(new Error(`unstubbed fetch: ${path}`))
  })
  return calls
}

const okWith =
  (rows: ReadonlyArray<SessionSummary>): SessionsHandler =>
  () =>
    Promise.resolve(jsonResponse(200, { sessions: rows }))

const renderAt = (path: string) =>
  render(
    <TestRouter initialEntries={[path]}>
      <AppRoutes />
    </TestRouter>,
  )

const control = (name: RegExp): HTMLSelectElement => {
  const element = screen.getByRole("combobox", { name })
  if (!(element instanceof HTMLSelectElement)) throw new Error(`${name} is not a select`)
  return element
}

afterEach(() => {
  vi.unstubAllGlobals()
})

test("S23: loading /sessions?project=p&user=u&range=week shows all three controls set from the query string - not reset to defaults", async () => {
  stubFetch(okWith([session]))

  renderAt("/sessions?project=samskara&user=maya&range=week")

  await screen.findByRole("button", { name: /port the session detail surface/i })

  expect(control(/project/i).value).toBe("samskara")
  expect(control(/user/i).value).toBe("maya")
  expect(control(/last active/i).value).toBe("week")
})

test("S23: the request sent to the server carries the same filters the URL declared", async () => {
  const calls = stubFetch(okWith([session]))

  renderAt("/sessions?project=samskara&user=maya&range=week")

  await screen.findByRole("button", { name: /port the session detail surface/i })

  expect(calls).toContain("/api/sessions?project=samskara&user=maya&range=week")
  expect(calls.filter((path) => path !== "/api/sessions")).toEqual([
    "/api/sessions?project=samskara&user=maya&range=week",
  ])
})

test("S24: changing User to maya writes user=maya into the URL and refetches without a full page load", async () => {
  const calls = stubFetch(okWith([session]))

  renderAt("/sessions?project=samskara")

  await screen.findByRole("button", { name: /port the session detail surface/i })
  await userEvent.selectOptions(control(/user/i), "maya")

  await waitFor(() =>
    expect(screen.getByTestId("location")).toHaveTextContent("project=samskara&user=maya"),
  )
  expect(calls.at(-1)).toBe("/api/sessions?project=samskara&user=maya")
})

test("S24: clearing the Project filter removes project= from the URL rather than leaving project=", async () => {
  stubFetch(okWith([session]))

  renderAt("/sessions?project=samskara")

  await screen.findByRole("button", { name: /port the session detail surface/i })
  await userEvent.selectOptions(control(/project/i), "")

  await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/sessions"))
  expect(screen.getByTestId("location")).not.toHaveTextContent("project=")
})

test("S25: an empty result keeps the filter values and offers a clear-filters action", async () => {
  stubFetch(okWith([]))

  renderAt("/sessions?project=samskara&user=maya&range=week")

  expect(await screen.findByText(/no sessions match/i)).toBeInTheDocument()
  expect(control(/project/i).value).toBe("samskara")
  expect(control(/user/i).value).toBe("maya")
  expect(control(/last active/i).value).toBe("week")

  await userEvent.click(screen.getByRole("button", { name: /clear filters/i }))

  await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/sessions"))
  expect(screen.getByTestId("location")).not.toHaveTextContent("?")
})

test("EDGE-003: a 404 projectNotFound renders a permission-denied state with a link back to all sessions - not an empty list", async () => {
  stubFetch(() => Promise.resolve(jsonResponse(404, { error: "projectNotFound" })))

  renderAt("/sessions?project=locked")

  expect(await screen.findByText(/cannot be opened/i)).toBeInTheDocument()
  expect(screen.queryByText(/no sessions match/i)).not.toBeInTheDocument()

  await userEvent.click(screen.getByRole("button", { name: /all sessions/i }))

  await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/sessions"))
  expect(screen.getByTestId("location")).not.toHaveTextContent("project=locked")
})

test("S26: activating the row for s-1 navigates to /sessions/s-1", async () => {
  stubFetch(okWith([session]))

  renderAt("/sessions")

  const row = await screen.findByRole("button", { name: /port the session detail surface/i })
  await userEvent.click(row)

  await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/sessions/s-1"))
})

test("S25: when the vocabulary request fails, the controls still offer the values on screen rather than collapsing to no options at all", async () => {
  const ravi = { ...session, id: "s-2", title: "Trim the ingest pipeline", userLogin: "ravi" }

  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    const path = typeof input === "string" ? input : input.toString()
    if (path.endsWith("/api/auth/me")) return Promise.resolve(jsonResponse(200, user))
    if (path === "/api/sessions") return Promise.resolve(jsonResponse(503, { error: "down" }))
    if (path.startsWith("/api/sessions")) {
      return Promise.resolve(jsonResponse(200, { sessions: [session, ravi] }))
    }
    return Promise.reject(new Error(`unstubbed fetch: ${path}`))
  })

  renderAt("/sessions?range=week")

  await screen.findByRole("button", { name: /port the session detail surface/i })

  await waitFor(() => {
    const users = Array.from(control(/user/i).options).map((option) => option.value)
    expect(users).toEqual(["", "maya", "ravi"])
  })
  expect(Array.from(control(/project/i).options).map((option) => option.value)).toEqual([
    "",
    "samskara",
  ])
})

test("S25: with user=maya applied, ravi is still offered - options come from the unfiltered vocabulary, not the filtered rows", async () => {
  const ravi = { ...session, id: "s-2", title: "Trim the ingest pipeline", userLogin: "ravi" }
  const all = [session, ravi]

  stubFetch((url) => {
    const login = url.searchParams.get("user")
    const rows = login === null ? all : all.filter((row) => row.userLogin === login)
    return Promise.resolve(jsonResponse(200, { sessions: rows }))
  })

  renderAt("/sessions?user=maya")

  await screen.findByRole("button", { name: /port the session detail surface/i })

  await waitFor(() => {
    const users = Array.from(control(/user/i).options).map((option) => option.value)
    expect(users).toContain("ravi")
  })
  expect(control(/user/i).value).toBe("maya")
  expect(
    screen.queryByRole("button", { name: /trim the ingest pipeline/i }),
  ).not.toBeInTheDocument()
})
