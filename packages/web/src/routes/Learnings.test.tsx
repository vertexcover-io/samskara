import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { TestRouter } from "../tests/test-router.js"
import { Learnings } from "./Learnings.js"

const LEARNING = {
  id: "l-1",
  projectId: "p-1",
  audience: "agent",
  category: "tool-retry",
  title: "Bash failed 3 times in a row",
  detail: "After the second failure of the same call shape, change the approach.",
  evidence: [{ seq: 4, what: "failure 1 of Bash" }],
  status: "candidate",
  occurrenceCount: 2,
  fingerprint: "fp-1",
  firstSeenAt: "2026-08-25T10:00:00.000Z",
  lastSeenAt: "2026-08-25T12:00:00.000Z",
}

const COMMON = {
  fingerprint: "fp-1",
  audience: "agent",
  category: "tool-retry",
  title: "Bash failed 3 times in a row",
  detail: "After the second failure of the same call shape, change the approach.",
  status: "candidate",
  projectCount: 2,
  totalOccurrences: 5,
  projectNames: ["Samskara", "Other"],
}

const stubFetch = (routes: ReadonlyArray<{ match: string; status: number; body: unknown }>) => {
  vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url =
      typeof input === "string"
        ? input
        : new URL(input instanceof Request ? input.url : String(input)).pathname +
          new URL(input instanceof Request ? input.url : String(input)).search
    for (const route of routes) {
      if (url.includes(route.match)) {
        return Promise.resolve(new Response(JSON.stringify(route.body), { status: route.status }))
      }
    }
    return Promise.resolve(new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }))
  })
}

const projectsBody = {
  projects: [
    {
      id: "p-1",
      name: "Samskara",
      slug: "samskara",
      ownerType: "user",
      ownerSlug: "dev",
      sessionCount: 3,
      lastActiveAt: "2026-08-25T12:00:00.000Z",
    },
  ],
}

const renderPage = (path = "/learnings") =>
  render(
    <TestRouter initialEntries={[path]}>
      <Learnings />
    </TestRouter>,
  )

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

test("LR1: the page explains that only a person accepts a lesson, and shows candidate rows with Accept and Reject", async () => {
  stubFetch([
    { match: "/api/learnings", status: 200, body: { learnings: [LEARNING] } },
    { match: "/api/projects", status: 200, body: projectsBody },
  ])

  renderPage()

  expect(await screen.findByText(/only a person reading this page does/)).toBeInTheDocument()
  expect(screen.getByText(/samskara learn --write/)).toBeInTheDocument()
  const card = screen.getByText("Bash failed 3 times in a row").closest("article")
  expect(card).not.toBeNull()
  expect(within(card as HTMLElement).getByText(/seen 2 sessions/)).toBeInTheDocument()
  expect(within(card as HTMLElement).getByText(/For agents · tool-retry/)).toBeInTheDocument()
  expect(
    within(card as HTMLElement).getByText("Accept", { selector: "button" }),
  ).toBeInTheDocument()
  expect(
    within(card as HTMLElement).getByText("Reject", { selector: "button" }),
  ).toBeInTheDocument()
})

test("LR2: Accept calls the status endpoint and moves the row to accepted", async () => {
  const calls: { url: string; method: string; body: unknown }[] = []
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const request = input instanceof Request ? input : null
    const url = request ? request.url : String(input)
    const method = request?.method ?? init?.method ?? "GET"
    const bodyText = request ? request.body : (init?.body as string | undefined)
    let body: unknown = null
    if (typeof bodyText === "string") body = JSON.parse(bodyText)
    calls.push({ url, method, body })
    if (url.includes("/api/learnings/l-1/status")) {
      return Promise.resolve(
        new Response(JSON.stringify({ learning: { ...LEARNING, status: "accepted" } }), {
          status: 200,
        }),
      )
    }
    if (url.includes("/api/learnings")) {
      return Promise.resolve(
        new Response(JSON.stringify({ learnings: [LEARNING] }), { status: 200 }),
      )
    }
    return Promise.resolve(new Response(JSON.stringify(projectsBody), { status: 200 }))
  })

  renderPage()
  const user = userEvent.setup()
  const card = (await screen.findByText("Bash failed 3 times in a row")).closest("article")
  await user.click(within(card as HTMLElement).getByText("Accept", { selector: "button" }))

  await waitFor(() => {
    expect(
      calls.some(
        (call) => call.url.includes("/api/learnings/l-1/status") && call.method === "PATCH",
      ),
    ).toBe(true)
  })
  expect(within(card as HTMLElement).getByText("Accepted")).toBeInTheDocument()
  expect(
    within(card as HTMLElement).getByText("Retire", { selector: "button" }),
  ).toBeInTheDocument()
})

test("LR3: the common view lists cross-project lessons with their project names", async () => {
  stubFetch([
    { match: "/api/learnings/common", status: 200, body: { learnings: [COMMON] } },
    { match: "/api/projects", status: 200, body: projectsBody },
  ])

  renderPage("/learnings?view=common")

  const card = (await screen.findByText("Bash failed 3 times in a row")).closest("article")
  expect(within(card as HTMLElement).getByText(/2 projects/)).toBeInTheDocument()
  expect(within(card as HTMLElement).getByText(/Samskara · Other/)).toBeInTheDocument()
  // The common view carries no accept buttons — curation happens per project.
  expect(within(card as HTMLElement).queryByText("Accept", { selector: "button" })).toBeNull()
})

test("LR4: the empty state points at samskara review instead of showing a bare list", async () => {
  stubFetch([
    { match: "/api/learnings", status: 200, body: { learnings: [] } },
    { match: "/api/projects", status: 200, body: projectsBody },
  ])

  renderPage()

  expect(
    await screen.findByText("Reviews have not produced lessons for this view"),
  ).toBeInTheDocument()
  expect(screen.getByText(/samskara review/)).toBeInTheDocument()
})

test("LR5: a filter failure surfaces the error, not a silent blank", async () => {
  stubFetch([{ match: "/api/learnings", status: 500, body: { error: "internal" } }])

  renderPage()

  expect(await screen.findByText("Retrieval failed")).toBeInTheDocument()
})
