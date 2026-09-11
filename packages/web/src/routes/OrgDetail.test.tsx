import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import type { OrgDetail as OrgDetailPayload } from "../api/types.js"
import { TestRouter } from "../tests/test-router.js"
import { OrgDetail } from "./OrgDetail.js"

const ORG: OrgDetailPayload = {
  id: "o-1",
  githubSlug: "vertexcover-io",
  name: "vertexcover-io",
  autoAddMembers: true,
  members: [
    { id: "u-1", githubLogin: "ritesh", avatarUrl: null },
    { id: "u-2", githubLogin: "maya", avatarUrl: null },
  ],
  projects: [
    { id: "p-1", name: "samskara", slug: "samskara", sessionCount: 3 },
    { id: "p-2", name: "andromeda", slug: "andromeda", sessionCount: 4 },
  ],
  sessionCount: 7,
}

const renderDetail = (org: OrgDetailPayload, entry = "/orgs/vertexcover-io") => {
  vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = typeof input === "string" ? input : String(input)
    if (url.includes("/api/orgs/")) {
      return Promise.resolve(new Response(JSON.stringify({ org }), { status: 200 }))
    }
    return Promise.resolve(new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }))
  })

  return render(
    <TestRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/orgs/:slug" element={<OrgDetail />} />
      </Routes>
    </TestRouter>,
  )
}

type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const renderWithFetch = (impl: FetchImpl, entry = "/orgs/vertexcover-io") => {
  vi.spyOn(globalThis, "fetch").mockImplementation(impl)
  return render(
    <TestRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/orgs/:slug" element={<OrgDetail />} />
      </Routes>
    </TestRouter>,
  )
}

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status })

const isPatch = (init: RequestInit | undefined): boolean => init?.method === "PATCH"

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

test("SC18: an org page shows its members, its projects and one total", async () => {
  renderDetail(ORG)

  await screen.findByRole("heading", { name: "vertexcover-io" })
  expect(screen.getByText("ritesh")).toBeInTheDocument()
  expect(screen.getByText("maya")).toBeInTheDocument()
  expect(screen.getByText("samskara")).toBeInTheDocument()
  expect(screen.getByText("andromeda")).toBeInTheDocument()
  expect(screen.getByText("3")).toBeInTheDocument()
  expect(screen.getByText("4")).toBeInTheDocument()
  expect(
    within(screen.getByRole("group", { name: "Org totals" })).getByText("7"),
  ).toBeInTheDocument()
})

test("SC19: the total follows the projects listed", async () => {
  const { unmount } = renderDetail(ORG)
  await screen.findByRole("heading", { name: "vertexcover-io" })
  expect(
    within(screen.getByRole("group", { name: "Org totals" })).getByText("7"),
  ).toBeInTheDocument()
  unmount()

  renderDetail({
    ...ORG,
    projects: [{ id: "p-3", name: "solo", slug: "solo", sessionCount: 10 }],
    sessionCount: 10,
  })

  await screen.findByRole("heading", { name: "vertexcover-io" })
  expect(
    within(screen.getByRole("group", { name: "Org totals" })).getByText("10"),
  ).toBeInTheDocument()
})

test("SC25: the toggle reflects what the server returned, not the click", async () => {
  const user = userEvent.setup()
  let resolvePatch: (response: Response) => void = () => {}
  const patchPromise = new Promise<Response>((resolve) => {
    resolvePatch = resolve
  })

  renderWithFetch((input, init) => {
    const url = typeof input === "string" ? input : String(input)
    if (!url.includes("/api/orgs/"))
      return Promise.resolve(jsonResponse(401, { error: "unauthorized" }))
    if (isPatch(init)) return patchPromise
    return Promise.resolve(jsonResponse(200, { org: { ...ORG, autoAddMembers: false } }))
  })

  const toggle = await screen.findByRole("checkbox", { name: /automatically/i })
  const saveButton = screen.getByRole("button", { name: /save/i })
  expect(toggle).not.toBeChecked()
  expect(saveButton).toBeDisabled()

  await user.click(toggle)
  expect(saveButton).toBeEnabled()

  await user.click(saveButton)
  expect(toggle).toBeDisabled()

  resolvePatch(jsonResponse(200, { org: { ...ORG, autoAddMembers: true } }))

  await waitFor(() => expect(toggle).toBeChecked())
  expect(toggle).not.toBeDisabled()
  expect(await screen.findByText("Saved")).toBeInTheDocument()
})

test("SC26: a failed toggle goes back to the old value and says so", async () => {
  const user = userEvent.setup()
  let resolvePatch: (response: Response) => void = () => {}
  const patchPromise = new Promise<Response>((resolve) => {
    resolvePatch = resolve
  })

  renderWithFetch((input, init) => {
    const url = typeof input === "string" ? input : String(input)
    if (!url.includes("/api/orgs/"))
      return Promise.resolve(jsonResponse(401, { error: "unauthorized" }))
    if (isPatch(init)) return patchPromise
    return Promise.resolve(jsonResponse(200, { org: { ...ORG, autoAddMembers: false } }))
  })

  const toggle = await screen.findByRole("checkbox", { name: /automatically/i })
  await user.click(toggle)
  await user.click(screen.getByRole("button", { name: /save/i }))

  resolvePatch(jsonResponse(500, { error: "internal" }))

  await waitFor(() => expect(toggle).not.toBeChecked())
  expect(await screen.findByRole("alert")).toBeInTheDocument()
})

test("SC53: clearing the name field sends null, and a real name sends itself", async () => {
  const user = userEvent.setup()
  const sent: Array<unknown> = []

  const stub = (patched: string) =>
    renderWithFetch((input, init) => {
      const url = typeof input === "string" ? input : String(input)
      if (!url.includes("/api/orgs/"))
        return Promise.resolve(jsonResponse(401, { error: "unauthorized" }))
      if (isPatch(init)) {
        sent.push(init?.body ? JSON.parse(String(init.body)) : null)
        return Promise.resolve(jsonResponse(200, { org: { ...ORG, name: patched } }))
      }
      return Promise.resolve(jsonResponse(200, { org: ORG }))
    })

  const { unmount } = stub("Vertexcover")
  await screen.findByRole("heading", { name: "vertexcover-io" })
  await user.clear(screen.getByRole("textbox", { name: /display name/i }))
  await user.type(screen.getByRole("textbox", { name: /display name/i }), "  Vertexcover  ")
  await user.click(screen.getByRole("button", { name: /save/i }))
  await screen.findByRole("heading", { name: "Vertexcover" })
  unmount()

  stub("vertexcover-io")
  await screen.findByRole("heading", { name: "vertexcover-io" })
  await user.clear(screen.getByRole("textbox", { name: /display name/i }))
  await user.click(screen.getByRole("button", { name: /save/i }))
  await waitFor(() => expect(sent).toHaveLength(2))

  expect(sent[0]).toEqual({ name: "Vertexcover" })
  expect(sent[1]).toEqual({ name: null })
})

test("SC44: saving a new name puts it in the heading", async () => {
  const user = userEvent.setup()

  renderWithFetch((input, init) => {
    const url = typeof input === "string" ? input : String(input)
    if (!url.includes("/api/orgs/"))
      return Promise.resolve(jsonResponse(401, { error: "unauthorized" }))
    if (isPatch(init))
      return Promise.resolve(jsonResponse(200, { org: { ...ORG, name: "Vertexcover" } }))
    return Promise.resolve(jsonResponse(200, { org: ORG }))
  })

  await screen.findByRole("heading", { name: "vertexcover-io" })
  const nameInput = screen.getByRole("textbox", { name: /display name/i })
  await user.clear(nameInput)
  await user.type(nameInput, "Vertexcover")
  await user.click(screen.getByRole("button", { name: /save/i }))

  await screen.findByRole("heading", { name: "Vertexcover" })
  const heading = screen.getByRole("heading", { name: "Vertexcover" })
  expect(heading.nextElementSibling).toHaveTextContent("vertexcover-io")
})
