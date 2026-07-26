import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { watcherPid } from "../config/daemon.js"
import { upsertProject } from "../config/projects.js"
import { statusCommand } from "./status.js"

vi.mock("../config/daemon.js", () => ({ watcherPid: vi.fn(() => null) }))

const stubFetch = (impl: typeof globalThis.fetch): void => {
  vi.stubGlobal("fetch", vi.fn(impl))
}

const originalHome = process.env.SAMSKARA_HOME

beforeEach(() => {
  vi.mocked(watcherPid).mockReturnValue(null)
})

afterEach(() => {
  process.env.SAMSKARA_HOME = originalHome
  vi.unstubAllGlobals()
})

describe("status command", () => {
  test("REQ-012,REQ-013,EDGE-006: lists all projects and the latest checkpoint for each slug", async () => {
    const home = await mkdtemp(join(tmpdir(), "samskara-status-"))
    process.env.SAMSKARA_HOME = home
    await upsertProject("acme-widget", {
      name: "widget",
      path: "/work/widget",
      enabled: true,
      enabledAt: "2026-07-25T09:00:00.000Z",
    })
    await upsertProject("acme-off", {
      name: "off",
      path: "/work/off",
      enabled: false,
      enabledAt: "2026-07-25T08:00:00.000Z",
    })
    await writeFile(
      join(home, "state.json"),
      JSON.stringify({
        checkpoints: {
          a: {
            filePath: "a",
            lastUpdatedAt: "2026-07-25T10:00:00.000Z",
            projectSlug: "acme-widget",
            source: "claude_code",
            mtime: 1,
            size: 1,
            lineProcessed: 1,
          },
          b: {
            filePath: "b",
            lastUpdatedAt: "2026-07-25T11:00:00.000Z",
            projectSlug: "acme-widget",
            source: "claude_code",
            mtime: 1,
            size: 1,
            lineProcessed: 1,
          },
        },
      }),
      "utf8",
    )
    const output: string[] = []

    vi.mocked(watcherPid).mockReturnValue(123)

    const code = await statusCommand({ stdout: { write: (text) => output.push(text) } })
    const text = output.join("")

    expect(code).toBe(0)
    expect(text).toContain("acme-widget")
    expect(text).toContain("/work/widget")
    expect(text).toContain("2026-07-25T11:00:00.000Z")
    expect(text).toContain("acme-off")
    expect(text).toMatch(/acme-off.*disabled.*-/)
    expect(text).toContain("Watcher: running as process 123")
    expect(text).toContain(join(home, "logs"))
  })

  test("REQ-012,REQ-014: empty registry reports an empty state and stopped watcher", async () => {
    process.env.SAMSKARA_HOME = await mkdtemp(join(tmpdir(), "samskara-status-empty-"))
    const output: string[] = []

    const code = await statusCommand({ stdout: { write: (text) => output.push(text) } })

    expect(code).toBe(0)
    expect(output.join("")).toContain("No projects are registered yet")
    expect(output.join("")).toContain("Watcher: not running")
  })

  test("reports an unpaired CLI without calling the server", async () => {
    process.env.SAMSKARA_HOME = await mkdtemp(join(tmpdir(), "samskara-status-unpaired-"))
    const output: string[] = []
    stubFetch(async () => new Response("{}", { status: 200 }))

    const code = await statusCommand({ stdout: { write: (text) => output.push(text) } })

    expect(code).toBe(0)
    expect(globalThis.fetch).not.toHaveBeenCalled()
    expect(output.join("")).toContain("not paired with an account yet")
  })

  test("names the paired identity when the token is accepted", async () => {
    const home = await mkdtemp(join(tmpdir(), "samskara-status-paired-"))
    process.env.SAMSKARA_HOME = home
    await writeFile(join(home, "token"), "cli-token", { mode: 0o600 })
    const output: string[] = []

    stubFetch(
      async () =>
        new Response(
          JSON.stringify({
            id: "user-1",
            githubLogin: "kgritesh",
            email: null,
            name: null,
            avatarUrl: null,
          }),
          { status: 200 },
        ),
    )

    const code = await statusCommand({ stdout: { write: (text) => output.push(text) } })

    expect(code).toBe(0)
    expect(output.join("")).toContain("paired as kgritesh")
  })

  test("surfaces a rejected token instead of reporting healthy", async () => {
    const home = await mkdtemp(join(tmpdir(), "samskara-status-stale-"))
    process.env.SAMSKARA_HOME = home
    await writeFile(join(home, "token"), "expired-token", { mode: 0o600 })
    const output: string[] = []

    stubFetch(async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }))

    const code = await statusCommand({ stdout: { write: (text) => output.push(text) } })

    expect(code).toBe(0)
    expect(output.join("")).toContain("no longer accepted")
    expect(output.join("")).toContain("samskara login")
  })
})
