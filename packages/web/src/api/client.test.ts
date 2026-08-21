import { afterEach, expect, test, vi } from "vitest"
import { getJson, request } from "./client.js"

const response = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

afterEach(() => vi.unstubAllGlobals())

test("SC1: a 401 response becomes an unauthorized error with the session-expired message", async () => {
  const result = await request(() => Promise.resolve(response(401, { error: "unauthorized" })))
  expect(result).toEqual({
    ok: false,
    error: { kind: "unauthorized", code: "unauthorized", message: "Your session has expired." },
  })
})

test("SC2: a 404 response becomes a notFound error that keeps the server's error code", async () => {
  const result = await request(() => Promise.resolve(response(404, { error: "projectNotFound" })))
  expect(result).toEqual({
    ok: false,
    error: { kind: "notFound", code: "projectNotFound", message: "That resource does not exist." },
  })
})

test("SC3: a status the contract does not describe becomes a server error naming it", async () => {
  const result = await request(() => Promise.resolve(response(500, { error: "internal" })))
  expect(result).toEqual({
    ok: false,
    error: { kind: "server", code: "internal", message: "The server responded with 500." },
  })
})

test("SC4: a response body that is not JSON becomes a server error, not a thrown exception", async () => {
  const malformed = new Response("not json", { status: 200 })
  const result = await request(() => Promise.resolve(malformed))
  expect(result).toEqual({
    ok: false,
    error: { kind: "server", code: null, message: "The server sent a malformed response." },
  })
})

test("SC5: an aborted request becomes a network error that says it was cancelled", async () => {
  const aborted = () => {
    const error = new Error("aborted")
    error.name = "AbortError"
    return Promise.reject(error)
  }
  const result = await request(aborted)
  expect(result).toEqual({
    ok: false,
    error: { kind: "network", code: null, message: "The request was cancelled." },
  })
})

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
