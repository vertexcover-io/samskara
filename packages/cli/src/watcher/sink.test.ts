import type { IngestPayload } from "@samskara/core"
import { describe, expect, test, vi } from "vitest"
import { createArtifactSink, createHttpSink } from "./sink.js"

const payload: IngestPayload = {
  type: "main",
  sessionId: "sess-1",
  source: "claude_code",
  project: { name: "widget", slug: "acme-widget" },
  sourceRelativePath: "sess-1.jsonl",
  records: [
    {
      lineUuid: "0191d942-3ba5-7dba-9a7d-22d65b30258c",
      lineNumber: 1,
      raw: {},
      messages: [
        {
          subIndex: 0,
          sessionId: "sess-1",
          source: "claude_code",
          sourceSchemaVersion: 1,
          trackId: "main",
          msgType: "custom",
          subType: "fixture",
        },
      ],
    },
  ],
}

const respond = (status: number, body = "") =>
  vi.fn(async () => new Response(body, { status })) as unknown as typeof globalThis.fetch

const authOf = (fetch: ReturnType<typeof respond>): ReadonlyArray<string | undefined> =>
  vi.mocked(fetch).mock.calls.map(([, init]) => {
    const headers = init?.headers as Record<string, string> | undefined
    return headers?.authorization
  })

describe("createHttpSink", () => {
  test("reads the token before every send, so a re-login lands without restarting the daemon", async () => {
    const tokens = ["stale", "fresh"]
    const fetch = respond(200, "{}")
    const sink = createHttpSink({
      apiBase: "http://api",
      readToken: async () => tokens.shift() ?? null,
      fetch,
    })

    await sink.send(payload)
    await sink.send(payload)

    expect(authOf(fetch)).toEqual(["Bearer stale", "Bearer fresh"])
  })

  test("a send with no stored token reports 401 and says to log in, without calling the server", async () => {
    const fetch = respond(200, "{}")
    const sink = createHttpSink({ apiBase: "http://api", readToken: async () => null, fetch })

    const result = await sink.send(payload)

    expect(result.status).toBe(401)
    expect(result.detail).toContain("samskara login")
    expect(fetch).not.toHaveBeenCalled()
  })

  test("a rejected send carries the server's response body as detail", async () => {
    const fetch = respond(409, JSON.stringify({ error: "sessionNotFound" }))
    const sink = createHttpSink({ apiBase: "http://api", readToken: async () => "t", fetch })

    const result = await sink.send(payload)

    expect(result.status).toBe(409)
    expect(result.detail).toContain("sessionNotFound")
  })

  test("an unreachable server reports status 0 with the network error as detail", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED")
    }) as unknown as typeof globalThis.fetch
    const sink = createHttpSink({ apiBase: "http://api", readToken: async () => "t", fetch })

    const result = await sink.send(payload)

    expect(result.status).toBe(0)
    expect(result.detail).toContain("ECONNREFUSED")
  })
})

describe("createArtifactSink", () => {
  test("reads the token before every send too", async () => {
    const tokens = ["stale", "fresh"]
    const fetch = respond(200, "{}")
    const sink = createArtifactSink({
      apiBase: "http://api",
      readToken: async () => tokens.shift() ?? null,
      fetch,
    })

    const upload = { sessionId: "sess-1", artifacts: [] } as never
    await sink.send(upload)
    await sink.send(upload)

    expect(authOf(fetch)).toEqual(["Bearer stale", "Bearer fresh"])
  })
})

const requestIdsOf = (fetch: ReturnType<typeof respond>): ReadonlyArray<string | undefined> =>
  vi.mocked(fetch).mock.calls.map(([, init]) => {
    const headers = init?.headers as Record<string, string> | undefined
    return headers?.["x-request-id"]
  })

describe("sink request ids", () => {
  test("every send stamps an x-request-id header and hands the same id back to the caller", async () => {
    const fetch = respond(200, "{}")
    const sink = createHttpSink({ apiBase: "http://api", readToken: async () => "t", fetch })

    const result = await sink.send(payload)

    expect(result.reqId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(requestIdsOf(fetch)).toEqual([result.reqId])
  })

  test("two sends get two different ids", async () => {
    const fetch = respond(200, "{}")
    const sink = createHttpSink({ apiBase: "http://api", readToken: async () => "t", fetch })

    const first = await sink.send(payload)
    const second = await sink.send(payload)

    expect(first.reqId).not.toBe(second.reqId)
  })

  test("an unreachable server still reports the id it tried, so a status 0 is traceable", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED")
    }) as unknown as typeof globalThis.fetch
    const sink = createHttpSink({ apiBase: "http://api", readToken: async () => "t", fetch })

    const result = await sink.send(payload)

    expect(result.status).toBe(0)
    expect(result.reqId).toBeTruthy()
  })

  test("a send with no stored token reports no id, because no request was made", async () => {
    const fetch = respond(200, "{}")
    const sink = createHttpSink({ apiBase: "http://api", readToken: async () => null, fetch })

    expect((await sink.send(payload)).reqId).toBeUndefined()
  })

  test("the artifact sink stamps an id too", async () => {
    const fetch = respond(200, "{}")
    const sink = createArtifactSink({ apiBase: "http://api", readToken: async () => "t", fetch })

    await sink.send({ sessionId: "sess-1", artifacts: [] } as never)

    expect(requestIdsOf(fetch)[0]).toBeTruthy()
  })
})
