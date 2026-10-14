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
  test.each([
    ["stops the running watcher and starts a fresh one", true],
    ["a watcher that was not running is still started", false],
  ])("%s, reporting the new pid", async (_case, wasRunning) => {
    const streams = output()
    vi.mocked(stopWatcherDaemon).mockResolvedValue(wasRunning)

    const code = await restartCommand(streams.writers)

    expect(code).toBe(0)
    expect(stopWatcherDaemon).toHaveBeenCalled()
    expect(startWatcherDaemon).toHaveBeenCalled()
    expect(streams.stdout.join("")).toContain("4242")
  })

  test.each([
    ["a missing token", null, "ok", []],
    ["a token the server rejects", "token", "rejected", [["token"]]],
  ] as const)(
    "%s fails with login guidance and never touches the watcher",
    async (_case, token, check, checked) => {
      const streams = output()
      vi.mocked(readToken).mockResolvedValue(token)
      vi.mocked(checkToken).mockResolvedValue(check)

      const code = await restartCommand(streams.writers)

      expect(code).toBe(1)
      expect(vi.mocked(checkToken).mock.calls).toEqual(checked)
      expect(streams.stderr.join("")).toContain("samskara login")
      expect(stopWatcherDaemon).not.toHaveBeenCalled()
      expect(startWatcherDaemon).not.toHaveBeenCalled()
    },
  )

  test("an unreachable server still restarts, saying the check was skipped", async () => {
    const streams = output()
    vi.mocked(checkToken).mockResolvedValue("unreachable")

    const code = await restartCommand(streams.writers)

    expect(code).toBe(0)
    expect(startWatcherDaemon).toHaveBeenCalled()
    expect(streams.stdout.join("")).toMatch(/could not be reached/i)
  })

  test("a failed start reports the error and exits non-zero", async () => {
    const streams = output()
    vi.mocked(startWatcherDaemon).mockRejectedValue(new Error("failed to spawn watcher daemon"))

    const code = await restartCommand(streams.writers)

    expect(code).toBe(1)
    expect(streams.stderr.join("")).toContain("failed to spawn watcher daemon")
  })
})
