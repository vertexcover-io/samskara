import { afterEach, expect, test, vi } from "vitest"
import { getJson } from "./client.js"

const response = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

afterEach(() => vi.unstubAllGlobals())

test("preserves stable server error codes from JSON failure responses", async () => {
  vi.stubGlobal("fetch", () => Promise.resolve(response(400, { error: "ambiguousCommit" })))

  const result = await getJson("/api/sessions", () => null)
  expect(result).toEqual({
    ok: false,
    error: { kind: "server", code: "ambiguousCommit", message: "The server responded with 400." },
  })
})

test("keeps status semantics while retaining a stable not-found code", async () => {
  vi.stubGlobal("fetch", () => Promise.resolve(response(404, { error: "projectNotFound" })))

  const result = await getJson("/api/sessions?project=private", () => null)
  expect(result).toEqual({
    ok: false,
    error: { kind: "notFound", code: "projectNotFound", message: "That resource does not exist." },
  })
})
