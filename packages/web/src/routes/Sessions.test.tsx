import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, test, vi } from "vitest"
import { AppRoutes } from "../App.js"
import type { CurrentUser, SessionSummary } from "../api/shapes.js"
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
  projectId: "p-1",
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

// Only the list endpoint (`/api/sessions` or `/api/sessions?...`) matches: a sub-resource path
// like `/api/sessions/s-1` is a different response shape, and no test here asserts on it.
const isSessionsList = (path: string): boolean =>
  path === "/api/sessions" || path.startsWith("/api/sessions?")

const stubFetch = (sessions: SessionsHandler): ReadonlyArray<string> => {
  const calls: Array<string> = []
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    const path = typeof input === "string" ? input : input.toString()
    if (path.endsWith("/api/auth/me")) return Promise.resolve(jsonResponse(200, user))
    if (isSessionsList(path)) {
      calls.push(path)
      return sessions(new URL(path, "http://localhost"))
    }
    return Promise.reject(new Error(`unstubbed fetch: ${path}`))
  })
  return calls
}

const filterOptions = {
  projects: [{ value: "samskara", label: "Samskara" }],
  authors: [
    { value: "maya", label: "maya" },
    { value: "ravi", label: "ravi" },
  ],
  repositories: [],
  branches: [],
}

const payload = (
  rows: ReadonlyArray<SessionSummary>,
  pagination = { page: 1, limit: 50, total: rows.length, totalPages: rows.length === 0 ? 0 : 1 },
) => ({ sessions: rows, pagination, filterOptions })

const okWith =
  (rows: ReadonlyArray<SessionSummary>): SessionsHandler =>
  () =>
    Promise.resolve(jsonResponse(200, payload(rows)))

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

test("every stable validation code presents the targeted recovery state", async () => {
  const validationCodes = [
    "invalidSearchQuery",
    "invalidPrNumber",
    "invalidCommit",
    "invalidTimeZone",
    "invalidRepo",
    "invalidBranch",
    "invalidPage",
    "invalidLimit",
    "invalidSort",
    "invalidRange",
    "invalidFilter",
  ] as const

  for (const error of validationCodes) {
    stubFetch(() => Promise.resolve(jsonResponse(400, { error })))
    const view = renderAt("/sessions?q=auth")
    expect(await screen.findByText(/check your search or filter/i)).toBeInTheDocument()
    expect(screen.queryByText(/retrieval failed/i)).not.toBeInTheDocument()
    view.unmount()
    vi.unstubAllGlobals()
  }
})

test("ambiguous commit has its own recovery state", async () => {
  stubFetch(() => Promise.resolve(jsonResponse(400, { error: "ambiguousCommit" })))
  renderAt("/sessions?commit=abcdef1")
  expect(await screen.findByText(/commit prefix is ambiguous/i)).toBeInTheDocument()
})

test("today initializes the URL before its only sessions request so the request includes timezone", async () => {
  const calls = stubFetch(okWith([session]))
  renderAt("/sessions?range=today")

  await screen.findByRole("link", { name: /port the session detail surface/i })
  expect(calls).toHaveLength(1)
  expect(new URL(calls.at(0) ?? "", "http://localhost").searchParams.get("tz")).toBe("UTC")
  expect(screen.getByTestId("location")).toHaveTextContent("range=today&tz=UTC")
})

test("stale sessions responses cannot replace newer filter results", async () => {
  let settleMaya: ((response: Response) => void) | undefined
  const calls = stubFetch((url) => {
    if (url.searchParams.get("user") === "maya") {
      return new Promise((resolve) => {
        settleMaya = resolve
      })
    }
    return Promise.resolve(jsonResponse(200, payload([{ ...session, title: "Latest result" }])))
  })
  renderAt("/sessions")

  expect(await screen.findByRole("link", { name: /latest result/i })).toBeInTheDocument()
  await userEvent.selectOptions(control(/user/i), "maya")
  await userEvent.selectOptions(control(/user/i), "")
  expect(await screen.findByRole("link", { name: /latest result/i })).toBeInTheDocument()
  settleMaya?.(jsonResponse(200, payload([{ ...session, title: "Stale result" }])))
  await waitFor(() =>
    expect(screen.queryByRole("link", { name: /stale result/i })).not.toBeInTheDocument(),
  )
  expect(calls).toHaveLength(3)
})

test("search clear removes relevance and pagination preserves remaining URL filters", async () => {
  const calls = stubFetch((url) => {
    const page = Number(url.searchParams.get("page") ?? "1")
    return Promise.resolve(
      jsonResponse(200, payload([session], { page, limit: 1, total: 2, totalPages: 2 })),
    )
  })
  renderAt("/sessions?q=timeout&project=samskara&sort=relevance")

  await screen.findByRole("link", { name: /port the session detail surface/i })
  await userEvent.click(screen.getByRole("button", { name: /clear search/i }))
  await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("project=samskara"))
  expect(screen.getByTestId("location")).not.toHaveTextContent("relevance")

  await userEvent.click(screen.getByRole("button", { name: "Next" }))
  await waitFor(() =>
    expect(screen.getByTestId("location")).toHaveTextContent("project=samskara&page=2"),
  )
  expect(calls.at(-1)).toBe("/api/sessions?project=samskara&page=2")
})

test("out-of-range pages render truthful empty pagination rather than a no-matches state", async () => {
  stubFetch(() =>
    Promise.resolve(
      jsonResponse(200, payload([], { page: 9, limit: 25, total: 1, totalPages: 1 })),
    ),
  )
  renderAt("/sessions?page=9")

  expect(await screen.findByText("Page 9 of 1")).toBeInTheDocument()
  expect(screen.getByText("Showing 0–0 of 1 sessions")).toBeInTheDocument()
  expect(screen.queryByText(/no sessions match/i)).not.toBeInTheDocument()
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
      return Promise.resolve(
        jsonResponse(200, {
          sessions: [session, ravi],
          pagination: { page: 1, limit: 50, total: 2, totalPages: 1 },
          filterOptions,
        }),
      )
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
    return Promise.resolve(
      jsonResponse(200, {
        sessions: rows,
        pagination: {
          page: 1,
          limit: 50,
          total: rows.length,
          totalPages: rows.length === 0 ? 0 : 1,
        },
        filterOptions,
      }),
    )
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

test("SC15: the sessions page renders each row the inferred list payload returns", async () => {
  const first = session
  const second = {
    ...session,
    id: "s-2",
    title: "Trim the ingest pipeline",
    projectName: "Andromeda",
    userLogin: "ravi",
    tokensTotal: 12_400_000,
    durationMs: null,
  }
  stubFetch(okWith([first, second]))

  renderAt("/sessions")

  const firstRow = await screen.findByRole("link", { name: /port the session detail surface/i })
  expect(firstRow).toHaveTextContent("Samskara")
  expect(firstRow).toHaveTextContent("maya")
  expect(firstRow).toHaveTextContent("4.2k tokens")

  const secondRow = screen.getByRole("link", { name: /trim the ingest pipeline/i })
  expect(secondRow).toHaveTextContent("Andromeda")
  expect(secondRow).toHaveTextContent("ravi")
  expect(secondRow).toHaveTextContent("12.4M tokens")
  expect(secondRow).toHaveTextContent("unavailable")
})

test("SC16: a search match decorates its row, and a row without one still renders", async () => {
  const matched = {
    ...session,
    match: {
      sourceKind: "toolResult" as const,
      sourceRowId: "tool-1",
      score: 1.5,
      snippet: [{ text: "deployment timeout", highlighted: true }],
    },
  }
  const unmatched = { ...session, id: "s-2", title: "Trim the ingest pipeline" }
  stubFetch(okWith([matched, unmatched]))

  renderAt("/sessions?q=timeout")

  const matchedRow = await screen.findByRole("link", { name: /port the session detail surface/i })
  expect(matchedRow.querySelector("mark")).toHaveTextContent("deployment timeout")

  const unmatchedRow = screen.getByRole("link", { name: /trim the ingest pipeline/i })
  expect(unmatchedRow.querySelector("mark")).toBeNull()
})

test("SC17: an ambiguous commit filter shows the failure state, not the session-expired state", async () => {
  stubFetch(() => Promise.resolve(jsonResponse(400, { error: "ambiguousCommit" })))

  renderAt("/sessions?commit=abcdef1")

  expect(await screen.findByRole("alert")).toHaveTextContent(/commit prefix is ambiguous/i)
  expect(screen.queryByRole("list")).not.toBeInTheDocument()
})

test("SC18: an unknown project filter shows the not-found state", async () => {
  stubFetch(() => Promise.resolve(jsonResponse(404, { error: "projectNotFound" })))

  renderAt("/sessions?project=locked")

  expect(await screen.findByText(/cannot be opened/i)).toBeInTheDocument()
  expect(screen.queryByRole("list")).not.toBeInTheDocument()
})

test("SC19 (regression): changing a filter refetches and keeps the previous rows visible until the new ones arrive", async () => {
  let settleSecond: ((response: Response) => void) | undefined
  const calls = stubFetch((url) => {
    if (url.searchParams.get("user") === "maya") {
      return new Promise((resolve) => {
        settleSecond = resolve
      })
    }
    return Promise.resolve(jsonResponse(200, payload([session])))
  })
  renderAt("/sessions")

  await screen.findByRole("link", { name: /port the session detail surface/i })
  await userEvent.selectOptions(control(/user/i), "maya")

  expect(calls).toHaveLength(2)
  expect(screen.getByRole("link", { name: /port the session detail surface/i })).toBeInTheDocument()

  const ravi = { ...session, id: "s-2", title: "Trim the ingest pipeline", userLogin: "ravi" }
  settleSecond?.(jsonResponse(200, payload([ravi])))

  await screen.findByRole("link", { name: /trim the ingest pipeline/i })
  expect(
    screen.queryByRole("link", { name: /port the session detail surface/i }),
  ).not.toBeInTheDocument()
})
