import { render, screen, waitFor } from "@testing-library/react"
import { Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import type { ProjectDetail as ProjectDetailPayload } from "../api/types.js"
import { TestRouter } from "../tests/test-router.js"
import { ProjectDetail } from "./ProjectDetail.js"

const PROJECT: ProjectDetailPayload = {
  id: "p-1",
  name: "samskara",
  slug: "samskara",
  owner: { type: "user", slug: "kgritesh" },
  sessionCount: 12,
  lastActiveAt: "2026-02-01T09:30:00.000Z",
}

const renderDetail = (
  project: ProjectDetailPayload,
  options: { entry?: string; viewerCanDelete?: boolean } = {},
) => {
  const { entry = "/projects/p-1", viewerCanDelete = false } = options
  vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = typeof input === "string" ? input : String(input)
    if (url.includes("/api/projects/")) {
      return Promise.resolve(
        new Response(JSON.stringify({ project, viewerCanDelete }), { status: 200 }),
      )
    }
    return Promise.resolve(new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }))
  })

  return render(
    <TestRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/projects/:id" element={<ProjectDetail />} />
      </Routes>
    </TestRouter>,
  )
}

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

test("SC1: a project page shows the project's name, slug, owner and session count, with a link to its sessions", async () => {
  renderDetail(PROJECT)

  await screen.findByRole("heading", { name: "samskara" })
  // Name and slug are both literally "samskara" here, so both must be on the page at once.
  expect(screen.getAllByText("samskara")).toHaveLength(2)
  expect(screen.getByText("kgritesh")).toBeInTheDocument()
  expect(screen.getByText("12")).toBeInTheDocument()
  expect(screen.getByRole("link", { name: /sessions/i })).toHaveAttribute(
    "href",
    "/sessions?project=p-1",
  )
})

test("SC2: the owner line follows who owns the project - org slug marked as an org, user login not marked", async () => {
  const { unmount } = renderDetail({
    ...PROJECT,
    owner: { type: "org", slug: "vertexcover-io" },
  })

  await waitFor(() => expect(screen.getByText(/vertexcover-io/)).toBeInTheDocument())
  expect(screen.getByRole("link", { name: /org · vertexcover-io/ })).toHaveAttribute(
    "href",
    "/orgs/vertexcover-io",
  )
  unmount()

  renderDetail({ ...PROJECT, owner: { type: "user", slug: "kgritesh" } })

  await waitFor(() => expect(screen.getByText("kgritesh")).toBeInTheDocument())
  expect(screen.queryByText(/org ·/)).not.toBeInTheDocument()
})

test("SC10: a viewer who may not delete is offered no delete control", async () => {
  renderDetail(PROJECT, { viewerCanDelete: false })

  await screen.findByRole("heading", { name: "samskara" })
  expect(screen.queryByRole("button", { name: /delete project/i })).not.toBeInTheDocument()
})
