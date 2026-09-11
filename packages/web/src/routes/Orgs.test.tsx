import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, test, vi } from "vitest"
import type { CurrentUser } from "../api/types.js"
import { TestRouter } from "../tests/test-router.js"
import { Orgs } from "./Orgs.js"

const memberUser: CurrentUser = {
  id: "u-1",
  githubLogin: "member",
  email: "member@example.com",
  name: "Member",
  avatarUrl: null,
  isSuperAdmin: false,
}

const adminUser: CurrentUser = {
  ...memberUser,
  id: "u-2",
  githubLogin: "admin",
  isSuperAdmin: true,
}

const ORGS = [{ id: "o-1", githubSlug: "vertexcover-io", name: "Vertexcover" }]

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

type Handlers = {
  readonly orgsGet?: () => Response
  readonly orgsPost?: (body: unknown) => Response
}

const stubFetch = (user: CurrentUser, handlers: Handlers = {}) => {
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === "string" ? input : input.toString()
    if (path.endsWith("/api/auth/me")) return Promise.resolve(jsonResponse(200, user))
    if (path.endsWith("/api/orgs") && init?.method === "POST") {
      const body: unknown = init.body ? JSON.parse(String(init.body)) : {}
      return Promise.resolve(
        handlers.orgsPost ? handlers.orgsPost(body) : jsonResponse(201, { githubSlug: "acme" }),
      )
    }
    if (path.endsWith("/api/orgs")) {
      return Promise.resolve(
        handlers.orgsGet ? handlers.orgsGet() : jsonResponse(200, { orgs: ORGS }),
      )
    }
    return Promise.reject(new Error(`unstubbed fetch: ${path}`))
  })
}

const renderOrgs = () =>
  render(
    <TestRouter initialEntries={["/orgs"]}>
      <Orgs />
    </TestRouter>,
  )

afterEach(() => {
  vi.restoreAllMocks()
})

test("SC32: the register form appears only for a super admin", async () => {
  stubFetch(memberUser)
  const { unmount } = renderOrgs()
  await screen.findByText("vertexcover-io")
  expect(screen.queryByRole("textbox", { name: /github org slug/i })).not.toBeInTheDocument()
  unmount()

  stubFetch(adminUser)
  renderOrgs()
  await screen.findByText("vertexcover-io")
  expect(screen.getByRole("textbox", { name: /github org slug/i })).toBeInTheDocument()
})

test("SC33: a registered org joins the list without a reload", async () => {
  const user = userEvent.setup()
  stubFetch(adminUser, {
    orgsPost: () => jsonResponse(201, { org: { id: "o-2", githubSlug: "acme", name: "acme" } }),
  })
  renderOrgs()

  await screen.findByText("vertexcover-io")
  const slugField = screen.getByRole("textbox", { name: /github org slug/i })
  await user.type(slugField, "acme")
  await user.click(screen.getByRole("button", { name: /register/i }))

  await waitFor(() => expect(screen.getByRole("link", { name: /acme/i })).toBeInTheDocument())
  expect(slugField).toHaveValue("")
})

test("SC49: re-registering an org already listed replaces its row rather than adding a second", async () => {
  const user = userEvent.setup()
  stubFetch(adminUser, {
    orgsPost: () =>
      jsonResponse(200, { org: { id: "o-1", githubSlug: "vertexcover-io", name: "Renamed" } }),
  })
  renderOrgs()

  await screen.findByText("vertexcover-io")
  await user.type(screen.getByRole("textbox", { name: /github org slug/i }), "vertexcover-io")
  await user.click(screen.getByRole("button", { name: /register/i }))

  await waitFor(() => expect(screen.getByText("Renamed")).toBeInTheDocument())
  expect(screen.getAllByRole("link", { name: /vertexcover-io/i })).toHaveLength(1)
})
