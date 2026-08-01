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
  anchorMessageId: null,
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
  const element = screen.getByRole("searchbox")
  if (!(element instanceof HTMLInputElement)) throw new Error("search box is not an input")
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

test("D19: loading /sessions?q=... pre-fills the search box from the URL", async () => {
  stubFetch(okWith([session]))

  renderAt("/sessions?q=memory%20leak")

  await screen.findByRole("button", { name: /port the session detail surface/i })

  expect(searchBox().value).toBe("memory leak")
})

test("D19: typing into the search box writes q and relevance into the URL, and refetches with q", async () => {
  const calls = stubFetch(okWith([session]))

  renderAt("/sessions")
  await screen.findByRole("button", { name: /port the session detail surface/i })

  await userEvent.type(searchBox(), "memory leak")

  await waitFor(() => {
    expect(screen.getByTestId("location")).toHaveTextContent("q=memory")
    expect(screen.getByTestId("location")).toHaveTextContent("sort=relevance")
  })
  expect(calls.at(-1)).toContain("q=memory")
})

test("D19: clearing the search box removes q and restores the recent sort", async () => {
  stubFetch(okWith([session]))

  renderAt("/sessions?q=memory+leak&sort=relevance")
  await screen.findByRole("button", { name: /port the session detail surface/i })

  await userEvent.clear(searchBox())

  await waitFor(() => expect(screen.getByTestId("location")).not.toHaveTextContent("q="))
  expect(screen.getByTestId("location")).not.toHaveTextContent("sort=")
})

test("D19: a search result's snippet renders on its row", async () => {
  stubFetch(() =>
    Promise.resolve(
      jsonResponse(200, {
        sessions: [{ ...session, snippet: "investigate the memory leak in the worker" }],
      }),
    ),
  )

  renderAt("/sessions?q=memory+leak")

  expect(await screen.findByText("investigate the memory leak in the worker")).toBeInTheDocument()
})

test("D22: opening a search result whose winning chunk carries an anchor lands on that message, not the top of the session", async () => {
  stubFetch(() =>
    Promise.resolve(jsonResponse(200, { sessions: [{ ...session, anchorMessageId: "m-9" }] })),
  )

  renderAt("/sessions?q=memory+leak")

  const row = await screen.findByRole("button", { name: /port the session detail surface/i })
  await userEvent.click(row)

  await waitFor(() =>
    expect(screen.getByTestId("location")).toHaveTextContent("/sessions/s-1?m=m-9"),
  )
})

test("a result with no anchor (a title-only match) opens the plain session, with no dangling ?m=", async () => {
  stubFetch(okWith([session]))

  renderAt("/sessions")

  const row = await screen.findByRole("button", { name: /port the session detail surface/i })
  await userEvent.click(row)

  await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/sessions/s-1"))
  expect(screen.getByTestId("location")).not.toHaveTextContent("m=")
})

test("a matched term in a snippet is marked, so a reader can see why the row came back", async () => {
  // The server delimits matches with control characters rather than markup, because snippet text
  // comes from tool output and must never reach the DOM as HTML.
  stubFetch(() =>
    Promise.resolve(
      jsonResponse(200, {
        sessions: [{ ...session, snippet: "the \u0002migration\u0003 never applied" }],
      }),
    ),
  )

  renderAt("/sessions?q=migration")

  const marked = await screen.findByText("migration")
  expect(marked.tagName).toBe("MARK")
  expect(screen.getByTestId("session-snippet")).toHaveTextContent("the migration never applied")
})

test("a snippet carrying markup renders it as text, never as elements", async () => {
  stubFetch(() =>
    Promise.resolve(
      jsonResponse(200, {
        sessions: [{ ...session, snippet: "<img src=x onerror=1> \u0002hit\u0003" }],
      }),
    ),
  )

  renderAt("/sessions?q=hit")

  const snippet = await screen.findByTestId("session-snippet")
  expect(snippet.querySelector("img")).toBeNull()
  expect(snippet).toHaveTextContent("<img src=x onerror=1>")
})

test("a search reports how many sessions matched and what it searched for", async () => {
  stubFetch(okWith([session]))

  renderAt("/sessions?q=memory+leak")

  const count = await screen.findByTestId("result-count")
  expect(count).toHaveTextContent("1 session matching")
  expect(count).toHaveTextContent("memory leak")
})

test("an empty result names the query rather than blaming the filters", async () => {
  stubFetch(okWith([]))

  renderAt("/sessions?q=xyzzy")

  expect(await screen.findByText(/Nothing found for/)).toBeInTheDocument()
  expect(screen.queryByText(/No sessions match these filters/)).toBeNull()
})

test("an empty result with no query still speaks about filters", async () => {
  stubFetch(okWith([]))

  renderAt("/sessions?project=none")

  expect(await screen.findByText(/No sessions match these filters/)).toBeInTheDocument()
})

test("the count claims 'best match first' only while the list is actually in that order", async () => {
  stubFetch(okWith([session]))

  renderAt("/sessions?q=memory+leak&sort=oldest")

  const count = await screen.findByTestId("result-count")
  // The query is still applied, so the count is still true -- but the reader chose a different
  // order, and asserting relevance ordering over an oldest-first list is simply false.
  expect(count).toHaveTextContent("1 session matching")
  expect(count).not.toHaveTextContent("best match first")
})
