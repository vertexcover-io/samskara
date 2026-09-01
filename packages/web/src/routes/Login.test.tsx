import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryRouter } from "react-router-dom"
import { afterEach, expect, test, vi } from "vitest"
import { Login } from "./Login.js"

test("S1: the sign-in control is an anchor to /api/auth/github/start - not a button that never leaves the SPA", () => {
  render(
    <MemoryRouter>
      <Login />
    </MemoryRouter>,
  )

  const link = screen.getByRole("link", { name: /continue with github/i })
  expect(link).toHaveAttribute("href", "/api/auth/github/start")
})

test("S2: the GitHub mark is decorative - it must not leak into the link's accessible name", () => {
  render(
    <MemoryRouter>
      <Login />
    </MemoryRouter>,
  )

  expect(screen.getByRole("link", { name: "Continue with GitHub" })).toBeInTheDocument()
  expect(screen.getByRole("heading", { level: 1, name: "samskara" })).toBeInTheDocument()
})

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

type MethodsResponse = () => Promise<Response>
type LocalResponse = (secret: string) => Promise<Response>

const stubAuthFetch = (methods: MethodsResponse, local?: LocalResponse): void => {
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === "string" ? input : input.toString()
    if (path.endsWith("/api/auth/methods")) return methods()
    if (path.endsWith("/api/auth/local")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { secret: string }
      return local ? local(body.secret) : Promise.reject(new Error("no local stub"))
    }
    return Promise.reject(new Error(`unstubbed fetch: ${path}`))
  })
}

const renderLogin = (onLocalSignedIn?: (path: string) => void) =>
  render(
    <MemoryRouter>
      <Login onLocalSignedIn={onLocalSignedIn} />
    </MemoryRouter>,
  )

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

test("L1: while /api/auth/methods says local=false no secret box appears", async () => {
  // github=false is the synchronisation point: without it this passes on the first paint.
  stubAuthFetch(() => Promise.resolve(jsonResponse(200, { github: false, local: false })))

  renderLogin()

  await waitFor(() =>
    expect(screen.queryByRole("link", { name: /continue with github/i })).not.toBeInTheDocument(),
  )
  expect(
    screen.queryByRole("button", { name: /sign in with local secret/i }),
  ).not.toBeInTheDocument()
  expect(screen.queryByLabelText("Local secret")).not.toBeInTheDocument()
})

test("L2: once /api/auth/methods says local=true the page offers the local secret control beside GitHub", async () => {
  stubAuthFetch(() => Promise.resolve(jsonResponse(200, { github: true, local: true })))

  renderLogin()

  expect(
    await screen.findByRole("button", { name: /sign in with local secret/i }),
  ).toBeInTheDocument()
  expect(screen.getByLabelText("Local secret")).toBeInTheDocument()
  expect(screen.getByRole("link", { name: /continue with github/i })).toBeInTheDocument()
})

test("L3: a successful local login sends the typed secret and reloads to /", async () => {
  stubAuthFetch(
    () => Promise.resolve(jsonResponse(200, { github: true, local: true })),
    () => Promise.resolve(jsonResponse(200, { id: "u-9", githubLogin: "samskara-dev" })),
  )
  const signedIn = vi.fn()

  renderLogin(signedIn)

  await userEvent.type(await screen.findByLabelText("Local secret"), "open sesame")
  await userEvent.click(screen.getByRole("button", { name: /sign in with local secret/i }))

  await waitFor(() => expect(signedIn).toHaveBeenCalledWith("/"))
})

test("L4: a rejected secret (401) shows a short inline error and keeps the control usable", async () => {
  stubAuthFetch(
    () => Promise.resolve(jsonResponse(200, { github: true, local: true })),
    () => Promise.resolve(jsonResponse(401, { error: "unauthorized" })),
  )

  renderLogin()

  await userEvent.type(await screen.findByLabelText("Local secret"), "not-the-secret")
  await userEvent.click(screen.getByRole("button", { name: /sign in with local secret/i }))

  expect(await screen.findByRole("alert")).toHaveTextContent(/secret/i)
  expect(screen.getByRole("button", { name: /sign in with local secret/i })).toBeEnabled()
})

test("L5: a 404 unknown_user surfaces the seed hint rather than a generic failure", async () => {
  stubAuthFetch(
    () => Promise.resolve(jsonResponse(200, { github: true, local: true })),
    () =>
      Promise.resolve(
        jsonResponse(404, { error: "unknown_user", message: "run `bun run seed` first" }),
      ),
  )

  renderLogin()

  await userEvent.type(await screen.findByLabelText("Local secret"), "open sesame")
  await userEvent.click(screen.getByRole("button", { name: /sign in with local secret/i }))

  expect(await screen.findByRole("alert")).toHaveTextContent(/bun run seed/)
})

test("L6: typing after a rejection clears the alert straight away, before any new request", async () => {
  stubAuthFetch(
    () => Promise.resolve(jsonResponse(200, { github: true, local: true })),
    () => Promise.resolve(jsonResponse(401, { error: "unauthorized" })),
  )

  renderLogin()

  const field = await screen.findByLabelText("Local secret")
  await userEvent.type(field, "not-the-secret")
  await userEvent.click(screen.getByRole("button", { name: /sign in with local secret/i }))
  expect(await screen.findByRole("alert")).toBeInTheDocument()

  await userEvent.type(field, "x")

  expect(screen.queryByRole("alert")).not.toBeInTheDocument()
})

test("L7: an unconfigured GitHub app drops its button rather than linking to an error page", async () => {
  stubAuthFetch(() => Promise.resolve(jsonResponse(200, { github: false, local: true })))

  renderLogin()

  expect(
    await screen.findByRole("button", { name: /sign in with local secret/i }),
  ).toBeInTheDocument()
  expect(screen.queryByRole("link", { name: /continue with github/i })).not.toBeInTheDocument()
})
