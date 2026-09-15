import { expect, test } from "vitest"
import { type TagsOptions, tagsCommand } from "./tags.js"

type Call = { readonly url: string; readonly method: string; readonly body: unknown }

const stubFetch = (respond: (call: Call, index: number) => Response) => {
  const calls: Call[] = []
  const fetch = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const call: Call = {
      url: String(url),
      method: init?.method ?? "GET",
      body: init?.body === undefined ? null : JSON.parse(String(init.body)),
    }
    calls.push(call)
    return respond(call, calls.length - 1)
  }) as unknown as typeof globalThis.fetch
  return { fetch, calls }
}

const io = () => {
  const stdout: string[] = []
  const stderr: string[] = []
  return {
    stdout: { write: (text: string) => stdout.push(text) },
    stderr: { write: (text: string) => stderr.push(text) },
    out: () => stdout.join(""),
    err: () => stderr.join(""),
  }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const baseOptions = (
  writers: ReturnType<typeof io>,
  over: Partial<TagsOptions> = {},
): TagsOptions => ({
  action: "add",
  tags: ["harness"],
  apiBase: "http://test",
  readToken: () => Promise.resolve("test-token"),
  env: {},
  sessionId: "sess-1",
  stdout: writers.stdout,
  stderr: writers.stderr,
  sleep: () => Promise.resolve(),
  ...over,
})

test("ST9: --session-id wins over the environment", async () => {
  const writers = io()
  const { fetch, calls } = stubFetch(() => json(200, { session: { tags: ["harness"] } }))

  const code = await tagsCommand(
    baseOptions(writers, {
      fetch,
      sessionId: "explicit",
      env: { CLAUDE_CODE_SESSION_ID: "from-env" },
    }),
  )

  expect(code).toBe(0)
  expect(calls[0]?.url).toBe("http://test/api/sessions/explicit/tags")
  expect(calls[0]?.body).toEqual({ add: ["harness"] })
  expect(writers.out()).toBe("harness\n")
})

test("ST9: without the flag the session comes from CLAUDE_CODE_SESSION_ID", async () => {
  const writers = io()
  const { fetch, calls } = stubFetch(() => json(200, { session: { tags: ["harness"] } }))

  const code = await tagsCommand(
    baseOptions(writers, {
      fetch,
      env: { CLAUDE_CODE_SESSION_ID: "from-env" },
      ...{ sessionId: undefined },
    }),
  )

  expect(code).toBe(0)
  expect(calls[0]?.url).toBe("http://test/api/sessions/from-env/tags")
})

test("ST9: with neither, it explains how to name the session and sends nothing", async () => {
  const writers = io()
  const { fetch, calls } = stubFetch(() => json(200, {}))

  const code = await tagsCommand(baseOptions(writers, { fetch, env: {}, sessionId: undefined }))

  expect(code).toBe(1)
  expect(calls).toHaveLength(0)
  expect(writers.err()).toContain("--session-id")
})

test("ST9: rm sends a remove, and ls reads without a body", async () => {
  const writers = io()
  const { fetch, calls } = stubFetch((call) =>
    call.method === "GET" ? json(200, { tags: ["harness"] }) : json(200, { session: { tags: [] } }),
  )

  await tagsCommand(baseOptions(writers, { fetch, action: "rm", tags: ["demo"] }))
  await tagsCommand(baseOptions(writers, { fetch, action: "ls" }))

  expect(calls[0]?.body).toEqual({ remove: ["demo"] })
  expect(calls[1]?.method).toBe("GET")
  expect(writers.out()).toBe("no tags\nharness\n")
})

test("ST9: a 404 is retried until the window closes, then explained", async () => {
  const writers = io()
  const { fetch, calls } = stubFetch(() => json(404, { error: "sessionNotFound" }))
  let clock = 0

  const code = await tagsCommand(
    baseOptions(writers, {
      fetch,
      now: () => {
        clock += 11_000
        return clock
      },
    }),
  )

  expect(code).toBe(1)
  expect(calls.length).toBeGreaterThan(1)
  expect(writers.err()).toContain("not on the server yet")
})

test("ST9: a 403 is final and never retried", async () => {
  const writers = io()
  const { fetch, calls } = stubFetch(() => json(403, { error: "forbidden" }))

  const code = await tagsCommand(baseOptions(writers, { fetch }))

  expect(code).toBe(1)
  expect(calls).toHaveLength(1)
  expect(writers.err()).toContain("cannot edit")
})

test("ST9: a 401 points at samskara login", async () => {
  const writers = io()
  const { fetch } = stubFetch(() => json(401, { error: "unauthorized" }))

  const code = await tagsCommand(baseOptions(writers, { fetch }))

  expect(code).toBe(1)
  expect(writers.err()).toContain("samskara login")
})

test("ST9: naming no tag on add is refused before any request", async () => {
  const writers = io()
  const { fetch, calls } = stubFetch(() => json(200, {}))

  const code = await tagsCommand(baseOptions(writers, { fetch, tags: [] }))

  expect(code).toBe(1)
  expect(calls).toHaveLength(0)
  expect(writers.err()).toContain("at least one tag")
})
