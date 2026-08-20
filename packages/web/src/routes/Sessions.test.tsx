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
  snippet: null,
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

const searchBox = (): HTMLInputElement => {
  const element = screen.getByRole("searchbox", { name: /keyword/i })
  if (!(element instanceof HTMLInputElement)) throw new Error("keyword is not an input")
  return element
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

test("S23: loading /sessions?project=p&user=u&range=week shows all three controls set from the query string - not reset to defaults", async () => {
  stubFetch(okWith([session]))

  renderAt("/sessions?project=samskara&user=maya&range=week")

  await screen.findByRole("link", { name: /port the session detail surface/i })

  expect(control(/project/i).value).toBe("samskara")
  expect(control(/user/i).value).toBe("maya")
  expect(control(/last active/i).value).toBe("week")
})

test("S23: the request sent to the server carries the same filters the URL declared", async () => {
  const calls = stubFetch(okWith([session]))

  renderAt("/sessions?project=samskara&user=maya&range=week")

  await screen.findByRole("link", { name: /port the session detail surface/i })

  expect(calls).toContain("/api/sessions?project=samskara&user=maya&range=week")
  expect(calls.filter((path) => path !== "/api/sessions")).toEqual([
    "/api/sessions?project=samskara&user=maya&range=week",
  ])
})

test("S24: changing User to maya writes user=maya into the URL and refetches without a full page load", async () => {
  const calls = stubFetch(okWith([session]))

  renderAt("/sessions?project=samskara")

  await screen.findByRole("link", { name: /port the session detail surface/i })
  await userEvent.selectOptions(control(/user/i), "maya")

  await waitFor(() =>
    expect(screen.getByTestId("location")).toHaveTextContent("project=samskara&user=maya"),
  )
  expect(calls.at(-1)).toBe("/api/sessions?project=samskara&user=maya")
})

test("S24: clearing the Project filter removes project= from the URL rather than leaving project=", async () => {
  stubFetch(okWith([session]))

  renderAt("/sessions?project=samskara")

  await screen.findByRole("link", { name: /port the session detail surface/i })
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

  const row = await screen.findByRole("link", { name: /port the session detail surface/i })
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

  await screen.findByRole("link", { name: /port the session detail surface/i })

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

  await screen.findByRole("link", { name: /port the session detail surface/i })

  await waitFor(() => {
    const users = Array.from(control(/user/i).options).map((option) => option.value)
    expect(users).toContain("ravi")
  })
  expect(control(/user/i).value).toBe("maya")
  expect(screen.queryByRole("link", { name: /trim the ingest pipeline/i })).not.toBeInTheDocument()
})

test("SC20: a keyword with no sort in the URL defaults the sort control to Best match", async () => {
  stubFetch(okWith([session]))

  renderAt("/sessions?q=timeout")

  await screen.findByRole("link", { name: /port the session detail surface/i })
  expect(control(/sort by/i).value).toBe("best")
})

test("SC20: a keyword with an explicit sort in the URL keeps that sort", async () => {
  stubFetch(okWith([session]))

  renderAt("/sessions?q=timeout&sort=oldest")

  await screen.findByRole("link", { name: /port the session detail surface/i })
  expect(control(/sort by/i).value).toBe("oldest")
})

test("SC21: a keyword matching nothing names the keyword in the empty state and still offers to clear", async () => {
  stubFetch(okWith([]))

  renderAt("/sessions?q=zzzznotfound")

  const heading = await screen.findByRole("heading", { name: /no sessions match/i })
  expect(heading).toHaveTextContent("zzzznotfound")
  expect(screen.getByRole("button", { name: /clear filters/i })).toBeInTheDocument()
})

test("B1: clicking Clear filters while a keyword is set actually empties the query string and the input", async () => {
  stubFetch(okWith([]))

  renderAt("/sessions?q=zzz")

  await screen.findByRole("heading", { name: /no sessions match/i })
  await userEvent.click(screen.getByRole("button", { name: /clear filters/i }))

  await waitFor(() => expect(screen.getByTestId("location")).not.toHaveTextContent("q="), {
    timeout: 2000,
  })
  expect(searchBox().value).toBe("")
})

test("SC22: hasMore true shows a line naming the 50 best matches", async () => {
  stubFetch(() => Promise.resolve(jsonResponse(200, { sessions: [session], hasMore: true })))

  renderAt("/sessions?q=timeout")

  await screen.findByRole("link", { name: /port the session detail surface/i })
  expect(screen.getByText(/showing the 50 best matches/i)).toBeInTheDocument()
})

test("SC22: hasMore false shows no such line", async () => {
  stubFetch(okWith([session]))

  renderAt("/sessions?q=timeout")

  await screen.findByRole("link", { name: /port the session detail surface/i })
  expect(screen.queryByText(/showing the 50 best matches/i)).not.toBeInTheDocument()
})

test("SC23: typing five characters quickly writes the URL once, after the pause, and sends one request for the whole word", async () => {
  const calls = stubFetch(okWith([]))
  const testUser = userEvent.setup({ delay: 0 })

  renderAt("/sessions")
  await screen.findByRole("searchbox", { name: /keyword/i })

  await testUser.type(searchBox(), "abcde")

  expect(screen.getByTestId("location")).not.toHaveTextContent("q=")

  await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("q=abcde"), {
    timeout: 2000,
  })
  expect(calls.filter((path) => path.includes("q="))).toEqual(["/api/sessions?q=abcde"])
})

test("SC24: the project dropdown still offers all three projects when the keyword matches a session in only one", async () => {
  const samskara = { ...session, id: "s-1" }
  const andromeda = {
    ...session,
    id: "s-2",
    title: "Trim the ingest pipeline",
    projectSlug: "andromeda",
    projectName: "Andromeda",
  }
  const acme = {
    ...session,
    id: "s-3",
    title: "Wire the auth guard",
    projectSlug: "acme",
    projectName: "Acme",
  }

  stubFetch((url) => {
    const rows = url.searchParams.get("q") === null ? [samskara, andromeda, acme] : [samskara]
    return Promise.resolve(jsonResponse(200, { sessions: rows, hasMore: false }))
  })

  renderAt("/sessions?q=timeout")

  await screen.findByRole("link", { name: /port the session detail surface/i })

  await waitFor(() => {
    const labels = Array.from(control(/project/i).options).map((option) => option.label)
    expect(labels).toEqual(["All projects", "Acme", "Andromeda", "Samskara"])
  })
})

test("B2: choosing Most recent while a keyword is set is not immediately overridden back to Best match", async () => {
  stubFetch(okWith([session]))

  renderAt("/sessions?q=timeout")

  await screen.findByRole("link", { name: /port the session detail surface/i })
  expect(control(/sort by/i).value).toBe("best")

  await userEvent.selectOptions(control(/sort by/i), "recent")

  await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("sort=recent"))
  expect(control(/sort by/i).value).toBe("recent")
})

test("B2: erasing the keyword does not leave sort=best stuck in the URL", async () => {
  const testUser = userEvent.setup({ delay: 0 })
  stubFetch(okWith([session]))

  renderAt("/sessions?q=timeout")

  await screen.findByRole("link", { name: /port the session detail surface/i })
  expect(control(/sort by/i).value).toBe("best")

  await testUser.clear(searchBox())

  await waitFor(() => expect(screen.getByTestId("location")).not.toHaveTextContent("q="), {
    timeout: 2000,
  })
  expect(screen.getByTestId("location")).not.toHaveTextContent("sort=best")
  expect(control(/sort by/i).value).toBe("recent")
})
