import { render, screen } from "@testing-library/react"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import type { SyncStatusRow } from "../api/types.js"
import { TestRouter } from "../tests/test-router.js"
import { absoluteTime } from "../time.js"
import { SyncStatus } from "./SyncStatus.js"

const ROW: SyncStatusRow = {
  userId: "u-1",
  githubLogin: "maya",
  name: null,
  avatarUrl: null,
  projectId: "p-1",
  projectName: "Samskara",
  projectSlug: "samskara",
  sessionCount: 3,
  lastSyncedAt: "2026-08-20T10:00:00.000Z",
}

const stubFetch = (status: number, body: unknown) => {
  vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = typeof input === "string" ? input : String(input)
    if (url.includes("/api/sync-status")) {
      return Promise.resolve(new Response(JSON.stringify(body), { status }))
    }
    return Promise.resolve(new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }))
  })
}

const renderPage = () =>
  render(
    <TestRouter initialEntries={["/sync-status"]}>
      <SyncStatus />
    </TestRouter>,
  )

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

test("SC2: the page shows one row for each returned pair, each with its own project and sync time", async () => {
  const other: SyncStatusRow = {
    ...ROW,
    projectId: "p-2",
    projectName: "Andromeda",
    projectSlug: "andromeda",
    lastSyncedAt: "2026-08-19T09:00:00.000Z",
  }
  stubFetch(200, { rows: [ROW, other] })

  renderPage()

  expect(await screen.findByText("Samskara")).toBeInTheDocument()
  expect(screen.getByText("Andromeda")).toBeInTheDocument()
  expect(screen.getAllByText("maya")).toHaveLength(2)
  expect(screen.getByTitle(absoluteTime(ROW.lastSyncedAt as string))).toBeInTheDocument()
  expect(screen.getByTitle(absoluteTime(other.lastSyncedAt as string))).toBeInTheDocument()
})

test("SC3: a pair with no sessions reads 'never', holding no <time> element", async () => {
  stubFetch(200, { rows: [{ ...ROW, lastSyncedAt: null }] })

  renderPage()

  expect(await screen.findByText("never")).toBeInTheDocument()
  expect(document.querySelector("time")).toBeNull()
})

test("SC4: a user with no projects still gets a row, reading 'no projects' with a zero session count", async () => {
  stubFetch(200, {
    rows: [
      {
        ...ROW,
        githubLogin: "solo",
        projectId: null,
        projectName: null,
        projectSlug: null,
        sessionCount: 0,
        lastSyncedAt: null,
      },
    ],
  })

  renderPage()

  expect(await screen.findByText("solo")).toBeInTheDocument()
  expect(screen.getByText("no projects")).toBeInTheDocument()
  expect(screen.getByText("0")).toBeInTheDocument()
})

test("SC5: a server error paints the retrieval-failed panel with no table row", async () => {
  stubFetch(500, { error: "internal" })

  renderPage()

  expect(await screen.findByText(/retrieval failed/i)).toBeInTheDocument()
  expect(screen.queryByRole("row")).not.toBeInTheDocument()
})

test("SC6: an expired session paints the session-expired panel, not the retrieval-failed panel", async () => {
  stubFetch(401, { error: "unauthorized" })

  renderPage()

  expect(await screen.findByTestId("location")).toHaveTextContent("/login")
  expect(screen.queryByText(/retrieval failed/i)).not.toBeInTheDocument()
})
