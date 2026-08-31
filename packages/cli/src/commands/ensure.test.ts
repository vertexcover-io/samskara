import type { ProjectIdentity } from "@samskara/core"
import { beforeEach, describe, expect, test, vi } from "vitest"
import { readToken } from "../config/credentials.js"
import { reviveWatcher, watcherPid } from "../config/daemon.js"
import { isProjectEnabled } from "../config/projects.js"
import { scopeMismatch } from "../config/server-scope.js"
import { checkToken } from "../login.js"
import { resolveProject } from "../watcher/resolveProject.js"
import { ensureCommand } from "./ensure.js"

vi.mock("../config/credentials.js", () => ({ readToken: vi.fn() }))
vi.mock("../config/daemon.js", () => ({ reviveWatcher: vi.fn(), watcherPid: vi.fn() }))
vi.mock("../config/projects.js", () => ({ isProjectEnabled: vi.fn() }))
vi.mock("../config/server-scope.js", () => ({
  scopeMismatch: vi.fn(),
  TRIPWIRE_PATHS: vi.fn(() => []),
}))
vi.mock("../watcher/resolveProject.js", () => ({ resolveProject: vi.fn() }))
vi.mock("../login.js", () => ({ checkToken: vi.fn() }))

const project: ProjectIdentity = { name: "widget", slug: "acme-widget" }

const output = () => {
  const stdout: string[] = []
  const stderr: string[] = []
  return {
    stdout,
    stderr,
    writers: {
      stdout: { write: (text: string) => stdout.push(text) },
      stderr: { write: (text: string) => stderr.push(text) },
    },
  }
}

beforeEach(() => {
  vi.mocked(readToken).mockResolvedValue("token")
  vi.mocked(watcherPid).mockReturnValue(321)
  vi.mocked(reviveWatcher).mockResolvedValue(321)
  vi.mocked(resolveProject).mockResolvedValue(project)
  vi.mocked(isProjectEnabled).mockResolvedValue(true)
  vi.mocked(checkToken).mockResolvedValue("ok")
  vi.mocked(scopeMismatch).mockResolvedValue([])
})

describe("ensure command", () => {
  test("REQ-021: missing credentials emit login guidance without starting a watcher", async () => {
    const streams = output()
    vi.mocked(readToken).mockResolvedValue(null)

    const code = await ensureCommand(streams.writers)

    expect(code).toBe(0)
    expect(reviveWatcher).not.toHaveBeenCalled()
    expect(streams.stdout.join("")).toContain('"hookEventName":"SessionStart"')
    expect(streams.stdout.join("")).toContain("samskara login")
  })

  test("REQ-022: authenticated ensure revives a dead watcher", async () => {
    const streams = output()
    vi.mocked(watcherPid).mockReturnValueOnce(null).mockReturnValue(321)

    const code = await ensureCommand(streams.writers)

    expect(code).toBe(0)
    expect(reviveWatcher).toHaveBeenCalled()
    expect(streams.stdout).toEqual([])
  })

  test("REQ-023,EDGE-008: immediate daemon death emits fail-open capture guidance", async () => {
    const streams = output()
    vi.mocked(watcherPid).mockReturnValue(null)

    const code = await ensureCommand(streams.writers)

    expect(code).toBe(0)
    expect(streams.stdout.join("")).toContain("capture may be OFF")
    expect(streams.stdout.join("")).toContain("logs")
  })

  test("REQ-024: inactive current folder emits enable guidance", async () => {
    const streams = output()
    vi.mocked(isProjectEnabled).mockResolvedValue(false)

    const code = await ensureCommand({ cwd: "/work/widget", ...streams.writers })

    expect(code).toBe(0)
    expect(streams.stdout.join("")).toContain("acme-widget")
    expect(streams.stdout.join("")).toContain("samskara enable")
  })

  test("REQ-026: an enabled project whose stored token the server rejects warns to log in again", async () => {
    const streams = output()
    vi.mocked(checkToken).mockResolvedValue("rejected")

    const code = await ensureCommand(streams.writers)

    expect(code).toBe(0)
    expect(checkToken).toHaveBeenCalledWith("token")
    expect(streams.stdout.join("")).toContain("samskara login")
    expect(streams.stdout.join("")).toContain("acme-widget")
  })

  test("REQ-026b: an enabled project with an accepted token stays silent", async () => {
    const streams = output()

    const code = await ensureCommand(streams.writers)

    expect(code).toBe(0)
    expect(streams.stdout).toEqual([])
  })

  test("REQ-026c: an unreachable server is not reported as a rejected login", async () => {
    const streams = output()
    vi.mocked(checkToken).mockResolvedValue("unreachable")

    const code = await ensureCommand(streams.writers)

    expect(code).toBe(0)
    expect(streams.stdout.join("")).not.toContain("samskara login")
  })

  test("REQ-026d: a disabled project is not checked against the server at all", async () => {
    const streams = output()
    vi.mocked(isProjectEnabled).mockResolvedValue(false)

    await ensureCommand(streams.writers)

    expect(checkToken).not.toHaveBeenCalled()
  })

  test("REQ-025: unexpected failures never block SessionStart", async () => {
    const streams = output()
    vi.mocked(readToken).mockRejectedValue(new Error("disk unavailable"))

    const code = await ensureCommand(streams.writers)

    expect(code).toBe(0)
    expect(streams.stderr.join("")).toContain("disk unavailable")
  })

  test("SC24: a mismatched projects.json is reported as SessionStart context", async () => {
    const streams = output()
    vi.mocked(scopeMismatch).mockResolvedValue([
      { file: "/x/projects.json", recorded: "https://one.example", current: "https://two.example" },
    ])

    const code = await ensureCommand(streams.writers)

    expect(code).toBe(0)
    expect(streams.stdout.join("")).toContain("https://one.example")
    expect(streams.stdout.join("")).toContain("https://two.example")
    expect(streams.stdout.join("")).toContain("samskara init --force")
  })
})
