import { describe, expect, test } from "vitest"
import { learnCommand } from "./learn.js"

const writer = () => {
  let text = ""
  const write = (chunk: string): boolean => {
    text += chunk
    return true
  }
  return { write, text: () => text }
}

/** A fake server: answers each path from `routes`, and records every request. */
const server = (routes: Record<string, Array<{ status: number; body: unknown }>>) => {
  const calls: Array<{
    path: string
    method: string
    body: string | undefined
    auth: string | null
  }> = []
  const fetch = (async (url: string, init: RequestInit = {}) => {
    const path = url.replace("http://api", "")
    calls.push({
      path,
      method: init.method ?? "GET",
      body: init.body as string | undefined,
      auth: new Headers(init.headers).get("authorization"),
    })
    const queue = routes[path] ?? []
    const next = queue.length > 1 ? queue.shift() : queue[0]
    return new Response(JSON.stringify(next?.body ?? { error: "missing" }), {
      status: next?.status ?? 404,
    })
  }) as typeof globalThis.fetch
  return { fetch, calls }
}

const base = { apiBase: "http://api", readToken: async () => "tok", sleep: async () => {} }

describe("samskara learn", () => {
  test("LC1: starts a run with the absolute harness path, waits for it, then prints the learnings", async () => {
    const { fetch, calls } = server({
      "/api/learnings/runs": [{ status: 202, body: { runId: "r1" } }],
      "/api/learnings/runs/r1": [
        { status: 200, body: { run: { id: "r1", status: "running", error: null } } },
        { status: 200, body: { run: { id: "r1", status: "done", error: null } } },
      ],
      "/api/learnings?org=acme": [
        {
          status: 200,
          body: {
            learnings: [
              {
                title: "Says tests pass without running them",
                priority: "high",
                priorityReason: "a wrong result shipped",
                problem: "Work ships untested.",
                fixType: "skill",
                fix: "Add a test step.",
                problemCount: 4,
                sessionCount: 3,
              },
            ],
          },
        },
      ],
    })
    const stdout = writer()
    const code = await learnCommand({
      ...base,
      org: "acme",
      harnessPath: "../yok",
      fetch,
      stdout,
      stderr: writer(),
    })
    expect(code).toBe(0)
    expect(calls[0]?.method).toBe("POST")
    expect(calls[0]?.auth).toBe("Bearer tok")
    const sent = JSON.parse(calls[0]?.body ?? "{}") as { org: string; harnessPath: string }
    expect(sent.org).toBe("acme")
    expect(sent.harnessPath).toMatch(/^\/.*\/yok$/)
    expect(calls.filter((call) => call.path === "/api/learnings/runs/r1")).toHaveLength(2)
    expect(stdout.text()).toContain("1. [high] Says tests pass without running them")
    expect(stdout.text()).toContain("4 problems in 3 sessions")
    expect(stdout.text()).toContain("Fix (skill): Add a test step.")
  })

  test("LC2: a failed run is reported with its reason", async () => {
    const { fetch } = server({
      "/api/learnings/runs": [{ status: 202, body: { runId: "r1" } }],
      "/api/learnings/runs/r1": [
        { status: 200, body: { run: { id: "r1", status: "failed", error: "grouping failed" } } },
      ],
    })
    const stderr = writer()
    expect(await learnCommand({ ...base, org: "acme", fetch, stdout: writer(), stderr })).toBe(1)
    expect(stderr.text()).toContain("The learning run failed: grouping failed")
  })

  test("LC3: the server's refusals read as plain sentences", async () => {
    const { fetch } = server({
      "/api/learnings/runs": [{ status: 400, body: { error: "noHarnessPath" } }],
    })
    const stderr = writer()
    expect(await learnCommand({ ...base, org: "acme", fetch, stdout: writer(), stderr })).toBe(1)
    expect(stderr.text()).toContain("pass --harness-path")
  })
})
