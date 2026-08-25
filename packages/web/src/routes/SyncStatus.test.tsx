import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
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

const renderPage = (path = "/sync-status") =>
  render(
    <TestRouter initialEntries={[path]}>
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

  // The probe span is mounted from the first render, so waiting on the element resolves instantly
  // and reads the pre-redirect location. Wait on the text it carries instead.
  await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/login"))
  expect(screen.queryByText(/retrieval failed/i)).not.toBeInTheDocument()
})

test("SC18: the active column reports its direction to a screen reader, and the other three report none", async () => {
  stubFetch(200, { rows: [ROW] })

  renderPage("/sync-status?sort=user&dir=asc")

  const userHeader = await screen.findByRole("columnheader", { name: "User" })
  expect(userHeader).toHaveAttribute("aria-sort", "ascending")
  expect(screen.getByRole("columnheader", { name: "Project" })).toHaveAttribute("aria-sort", "none")
  expect(screen.getByRole("columnheader", { name: "Sessions" })).toHaveAttribute(
    "aria-sort",
    "none",
  )
  expect(screen.getByRole("columnheader", { name: "Last synced" })).toHaveAttribute(
    "aria-sort",
    "none",
  )
})

test("SC19: typing into the Project box writes it into the URL, and the default state leaves the URL clean", async () => {
  stubFetch(200, { rows: [ROW] })
  const user = userEvent.setup()

  renderPage()
  await screen.findByText("Samskara")
  expect(await screen.findByTestId("location")).toHaveTextContent("/sync-status")
  expect(screen.getByTestId("location")).not.toHaveTextContent("?")

  await user.type(screen.getByRole("combobox", { name: "Project" }), "sams")

  expect(screen.getByTestId("location")).toHaveTextContent("project=sams")
})

test("SC20: a URL carrying filter values applies them on first paint", async () => {
  const other: SyncStatusRow = {
    ...ROW,
    projectId: "p-2",
    projectName: "Andromeda",
    projectSlug: "andromeda",
  }
  stubFetch(200, { rows: [ROW, other] })

  renderPage("/sync-status?sort=user&dir=asc&project=samskara")

  expect(await screen.findByText("Samskara")).toBeInTheDocument()
  expect(screen.queryByText("Andromeda")).not.toBeInTheDocument()
  expect(screen.getByRole("columnheader", { name: "User" })).toHaveAttribute(
    "aria-sort",
    "ascending",
  )
})

test("SC24: clearing the filters keeps the reader's sort column and direction", async () => {
  stubFetch(200, { rows: [ROW] })
  const user = userEvent.setup()

  renderPage("/sync-status?sort=user&dir=asc&project=nothingmatchesthis")

  await user.click(await screen.findByRole("button", { name: "Clear filters" }))

  expect(await screen.findByText("Samskara")).toBeInTheDocument()
  expect(screen.getByTestId("location")).not.toHaveTextContent("project=")
  expect(screen.getByTestId("location")).toHaveTextContent("sort=user")
  expect(screen.getByTestId("location")).toHaveTextContent("dir=asc")
  expect(screen.getByRole("columnheader", { name: "User" })).toHaveAttribute(
    "aria-sort",
    "ascending",
  )
})

test("SC27: the Project box suggests the projects on the page, and picking one filters the table", async () => {
  const other: SyncStatusRow = {
    ...ROW,
    projectId: "p-2",
    projectName: "Andromeda",
    projectSlug: "andromeda",
  }
  stubFetch(200, { rows: [ROW, other] })
  const user = userEvent.setup()

  renderPage()
  await screen.findByText("Samskara")

  await user.click(screen.getByRole("combobox", { name: "Project" }))

  const list = screen.getByRole("listbox", { name: "Project" })
  expect(within(list).getByRole("option", { name: "Andromeda" })).toBeInTheDocument()
  expect(within(list).getByRole("option", { name: "Samskara" })).toBeInTheDocument()

  await user.click(within(list).getByRole("option", { name: "Andromeda" }))

  expect(screen.getByTestId("location")).toHaveTextContent("project=Andromeda")
  expect(screen.queryByText("Samskara")).not.toBeInTheDocument()
})

test("SC28: typing narrows the suggestions to the matching users only", async () => {
  const asha: SyncStatusRow = { ...ROW, userId: "u-2", githubLogin: "asha" }
  stubFetch(200, { rows: [ROW, asha] })
  const user = userEvent.setup()

  renderPage()
  await screen.findByText("asha")

  await user.type(screen.getByRole("combobox", { name: "User" }), "ash")

  const list = screen.getByRole("listbox", { name: "User" })
  expect(within(list).getByRole("option", { name: "asha" })).toBeInTheDocument()
  expect(within(list).queryByRole("option", { name: "maya" })).not.toBeInTheDocument()
})
