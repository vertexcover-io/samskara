import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, test, vi } from "vitest"
import { SessionSearch } from "./SessionSearch.js"

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const stubFetch = (handler: (url: URL) => Promise<Response>): ReadonlyArray<string> => {
  const calls: Array<string> = []
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    const path = typeof input === "string" ? input : input.toString()
    calls.push(path)
    return handler(new URL(path, "http://localhost"))
  })
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
})

const submit = async (query: string): Promise<void> => {
  const user = userEvent.setup()
  await user.type(screen.getByRole("searchbox", { name: /search this session/i }), query)
  await user.click(screen.getByRole("button", { name: /^search$/i }))
}

test("submitting a query fetches this session's scoped search endpoint and renders the ranked snippets", async () => {
  const calls = stubFetch(() =>
    Promise.resolve(
      jsonResponse(200, {
        chunks: [
          { anchorMessageId: "m-1", snippet: "the login timeout keeps happening", score: 0.03 },
        ],
      }),
    ),
  )

  render(<SessionSearch sessionId="s-1" onSelect={vi.fn()} />)
  await submit("login timeout")

  expect(await screen.findByText("the login timeout keeps happening")).toBeInTheDocument()
  expect(calls.at(-1)).toBe("/api/sessions/s-1/search?q=login%20timeout")
})

test("selecting a result whose chunk carries an anchor hands that anchor back to the caller", async () => {
  stubFetch(() =>
    Promise.resolve(
      jsonResponse(200, {
        chunks: [
          { anchorMessageId: "m-1", snippet: "the login timeout keeps happening", score: 0.03 },
        ],
      }),
    ),
  )
  const onSelect = vi.fn()

  render(<SessionSearch sessionId="s-1" onSelect={onSelect} />)
  await submit("login timeout")

  await userEvent.click(
    await screen.findByRole("button", { name: /login timeout keeps happening/i }),
  )

  expect(onSelect).toHaveBeenCalledWith("m-1")
})

test("a result with no anchor (a title-only match) cannot be selected -- there is no turn to jump to", async () => {
  stubFetch(() =>
    Promise.resolve(
      jsonResponse(200, {
        chunks: [{ anchorMessageId: null, snippet: "Outage investigation", score: 0.05 }],
      }),
    ),
  )
  const onSelect = vi.fn()

  render(<SessionSearch sessionId="s-1" onSelect={onSelect} />)
  await submit("outage")

  const result = await screen.findByRole("button", { name: /outage investigation/i })
  expect(result).toBeDisabled()

  await userEvent.click(result)
  expect(onSelect).not.toHaveBeenCalled()
})

test("a session with no matching chunk reports no matches rather than an empty, unexplained list", async () => {
  stubFetch(() => Promise.resolve(jsonResponse(200, { chunks: [] })))

  render(<SessionSearch sessionId="s-1" onSelect={vi.fn()} />)
  await submit("xenomorphic quasar")

  expect(await screen.findByText(/no matches in this session/i)).toBeInTheDocument()
})

test("a failed request surfaces a retrieval error rather than a silent empty result", async () => {
  stubFetch(() => Promise.resolve(jsonResponse(500, { error: "boom" })))

  render(<SessionSearch sessionId="s-1" onSelect={vi.fn()} />)
  await submit("login timeout")

  expect(await screen.findByText(/the server responded with 500/i)).toBeInTheDocument()
})

test("submitting a blank query fires no request", async () => {
  const calls = stubFetch(() => Promise.resolve(jsonResponse(200, { chunks: [] })))

  render(<SessionSearch sessionId="s-1" onSelect={vi.fn()} />)
  await submit("   ")

  await waitFor(() => expect(calls).toHaveLength(0))
})

test("a slow earlier search cannot overwrite the results of a newer one", async () => {
  // The first request resolves only after the second has already answered. Without a guard the
  // stale response lands last and the reader sees results for a query they already replaced.
  // A holder rather than a bare `let`: the assignment happens inside a promise callback, which
  // control-flow analysis cannot see, so a plain variable stays narrowed to `null` at the call.
  const gate: { release: (() => void) | null } = { release: null }
  let call = 0
  stubFetch(async (url) => {
    call += 1
    if (call === 1) {
      await new Promise<void>((resolve) => {
        gate.release = resolve
      })
      return jsonResponse(200, {
        chunks: [{ anchorMessageId: "m-1", snippet: "stale answer", score: 0.01 }],
      })
    }
    expect(url.searchParams.get("q")).toBe("fresh")
    return jsonResponse(200, {
      chunks: [{ anchorMessageId: "m-2", snippet: "fresh answer", score: 0.9 }],
    })
  })

  render(<SessionSearch sessionId="s-1" onSelect={vi.fn()} />)

  const user = userEvent.setup()
  const box = screen.getByRole("searchbox", { name: /search this session/i })
  const go = screen.getByRole("button", { name: /^search$/i })

  await user.type(box, "stale")
  await user.click(go)

  await user.clear(box)
  await user.type(box, "fresh")
  await user.click(go)

  expect(await screen.findByText(/fresh answer/)).toBeInTheDocument()

  gate.release?.()

  await waitFor(() => expect(screen.queryByText(/stale answer/)).not.toBeInTheDocument())
  expect(screen.getByText(/fresh answer/)).toBeInTheDocument()
})
