import type { ArtifactUploadPayload, IngestPayload } from "@samskara/core"
import { describe, expect, test, vi } from "vitest"
import { createArtifactSink, createHttpSink, type HttpSinkDeps, type SinkResult } from "./sink.js"

const payload: IngestPayload = {
  type: "main",
  sessionId: "sess-1",
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

const upload: ArtifactUploadPayload = {
  sessionId: "sess-1",
  path: "/repo/docs/notes.md",
  relativePath: "docs/notes.md",
  mimeType: "text/markdown",
  changeKind: "created",
  encoding: "utf8",
  currentContent: "# Notes",
  currentHash: "hash",
  observedAt: "2026-07-28T10:00:00.000Z",
}

const respond = (status: number, body = "") =>
  vi.fn(async () => new Response(body, { status })) as unknown as typeof globalThis.fetch

const headerOf = (
  fetch: ReturnType<typeof respond>,
  name: string,
): ReadonlyArray<string | undefined> =>
  vi.mocked(fetch).mock.calls.map(([, init]) => {
    const headers = init?.headers as Record<string, string> | undefined
    return headers?.[name]
  })

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

describe.each([
  {
    name: "createHttpSink",
    send: (deps: HttpSinkDeps): Promise<SinkResult> => createHttpSink(deps).send(payload),
  },
  {
    name: "createArtifactSink",
    send: (deps: HttpSinkDeps): Promise<SinkResult> => createArtifactSink(deps).send(upload),
  },
])("$name", ({ send }) => {
  test("reads the token before every send, so a re-login lands without restarting the daemon", async () => {
    const tokens = ["stale", "fresh"]
    const fetch = respond(200, "{}")
    const deps = { apiBase: "http://api", readToken: async () => tokens.shift() ?? null, fetch }

    await send(deps)
    await send(deps)

    expect(headerOf(fetch, "authorization")).toEqual(["Bearer stale", "Bearer fresh"])
  })

  test("every send stamps an x-request-id header and hands the same id back to the caller", async () => {
    const fetch = respond(200, "{}")

    const result = await send({ apiBase: "http://api", readToken: async () => "t", fetch })

    expect(result.reqId).toMatch(UUID)
    expect(headerOf(fetch, "x-request-id")).toEqual([result.reqId])
  })
})

describe("createHttpSink", () => {
  test("a send with no stored token reports 401, says to log in and has no request id, without calling the server", async () => {
    const fetch = respond(200, "{}")
    const sink = createHttpSink({ apiBase: "http://api", readToken: async () => null, fetch })

    const result = await sink.send(payload)

    expect(result.status).toBe(401)
    expect(result.detail).toContain("samskara login")
    expect(result.reqId).toBeUndefined()
    expect(fetch).not.toHaveBeenCalled()
  })

  test("a rejected send carries the server's response body as detail", async () => {
    const fetch = respond(409, JSON.stringify({ error: "sessionNotFound" }))
    const sink = createHttpSink({ apiBase: "http://api", readToken: async () => "t", fetch })

    const result = await sink.send(payload)

    expect(result.status).toBe(409)
    expect(result.detail).toContain("sessionNotFound")
  })

  test("an unreachable server reports status 0 with the network error as detail and the id it tried", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED")
    }) as unknown as typeof globalThis.fetch
    const sink = createHttpSink({ apiBase: "http://api", readToken: async () => "t", fetch })

    const result = await sink.send(payload)

    expect(result.status).toBe(0)
    expect(result.detail).toContain("ECONNREFUSED")
    expect(result.reqId).toMatch(UUID)
  })

  test("two sends get two different ids", async () => {
    const fetch = respond(200, "{}")
    const sink = createHttpSink({ apiBase: "http://api", readToken: async () => "t", fetch })

    const first = await sink.send(payload)
    const second = await sink.send(payload)

    expect(first.reqId).not.toBe(second.reqId)
  })
})
