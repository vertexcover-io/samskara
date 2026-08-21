import { beforeEach, describe, expect, test, vi } from "vitest"
import { readToken } from "../config/credentials.js"
import { startWatcherDaemon, stopWatcherDaemon } from "../config/daemon.js"
import { checkToken } from "../login.js"
import { restartCommand } from "./restart.js"

vi.mock("../config/credentials.js", () => ({ readToken: vi.fn() }))
vi.mock("../config/daemon.js", () => ({
  startWatcherDaemon: vi.fn(),
  stopWatcherDaemon: vi.fn(),
}))
vi.mock("../login.js", () => ({ checkToken: vi.fn() }))

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
  vi.mocked(checkToken).mockResolvedValue("ok")
  vi.mocked(stopWatcherDaemon).mockResolvedValue(true)
  vi.mocked(startWatcherDaemon).mockResolvedValue(4242)
})

describe("restart command", () => {
  test("stops the running watcher and starts a fresh one, reporting the new pid", async () => {
    const streams = output()

    const code = await restartCommand(streams.writers)

    expect(code).toBe(0)
    expect(stopWatcherDaemon).toHaveBeenCalled()
    expect(startWatcherDaemon).toHaveBeenCalled()
    expect(streams.stdout.join("")).toContain("4242")
  })

  test("a missing token fails with login guidance and never touches the watcher", async () => {
    const streams = output()
    vi.mocked(readToken).mockResolvedValue(null)

    const code = await restartCommand(streams.writers)

    expect(code).toBe(1)
    expect(streams.stderr.join("")).toContain("samskara login")
    expect(stopWatcherDaemon).not.toHaveBeenCalled()
    expect(startWatcherDaemon).not.toHaveBeenCalled()
  })

  test("a token the server rejects fails with login guidance and leaves the watcher alone", async () => {
    const streams = output()
    vi.mocked(checkToken).mockResolvedValue("rejected")

    const code = await restartCommand(streams.writers)

    expect(code).toBe(1)
    expect(checkToken).toHaveBeenCalledWith("token")
    expect(streams.stderr.join("")).toContain("samskara login")
    expect(stopWatcherDaemon).not.toHaveBeenCalled()
    expect(startWatcherDaemon).not.toHaveBeenCalled()
  })

  test("an unreachable server still restarts, saying the check was skipped", async () => {
    const streams = output()
    vi.mocked(checkToken).mockResolvedValue("unreachable")

    const code = await restartCommand(streams.writers)

    expect(code).toBe(0)
    expect(startWatcherDaemon).toHaveBeenCalled()
    expect(streams.stdout.join("")).toMatch(/could not be reached/i)
  })

  test("a watcher that was not running is still started", async () => {
    const streams = output()
    vi.mocked(stopWatcherDaemon).mockResolvedValue(false)

    const code = await restartCommand(streams.writers)

    expect(code).toBe(0)
    expect(startWatcherDaemon).toHaveBeenCalled()
    expect(streams.stdout.join("")).toContain("4242")
  })

  test("a failed start reports the error and exits non-zero", async () => {
    const streams = output()
    vi.mocked(startWatcherDaemon).mockRejectedValue(new Error("failed to spawn watcher daemon"))

    const code = await restartCommand(streams.writers)

    expect(code).toBe(1)
    expect(streams.stderr.join("")).toContain("failed to spawn watcher daemon")
  })
})
