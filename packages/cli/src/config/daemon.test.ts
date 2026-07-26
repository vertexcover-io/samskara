import { existsSync, writeFileSync } from "node:fs"
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test, vi } from "vitest"
import { resolveCliEntry, startWatcherDaemon, stopWatcherDaemon, watcherPid } from "./daemon.js"

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock("node:child_process", () => ({ spawn: spawnMock }))

const originalHome = process.env.SAMSKARA_HOME

const useHome = async (): Promise<string> => {
  const home = await mkdtemp(join(tmpdir(), "samskara-daemon-"))
  process.env.SAMSKARA_HOME = home
  return home
}

const child = (pid: number | undefined) => ({
  pid,
  unref: vi.fn(),
  kill: vi.fn(() => true),
})

const alive = (...pids: ReadonlyArray<number>) =>
  vi.spyOn(process, "kill").mockImplementation(((pid: number) => {
    if (!pids.includes(pid)) throw new Error("ESRCH")
    return true
  }) as never)

afterEach(() => {
  process.env.SAMSKARA_HOME = originalHome
  vi.restoreAllMocks()
  spawnMock.mockReset()
})

describe("cli entry resolution", () => {
  test("resolves to an entry file that exists, so the spawned daemon can run", () => {
    const entry = resolveCliEntry(() => undefined)
    expect(existsSync(entry)).toBe(true)
  })

  test("points at the CLI entry module rather than some other file", () => {
    expect(resolveCliEntry(() => undefined)).toMatch(/[/\\]index\.(js|ts)$/)
  })

  test("explains the fallback only when the compiled entry is absent", () => {
    const notices: string[] = []
    const entry = resolveCliEntry((message) => notices.push(message))

    if (entry.endsWith(".ts")) {
      expect(notices).toHaveLength(1)
      expect(notices[0]).toContain("started from the TypeScript source")
    } else {
      expect(notices).toEqual([])
    }
  })
})

describe("watcher daemon", () => {
  test("REQ-020: starts a detached singleton and persists its PID at 0600", async () => {
    const home = await useHome()
    const spawned = child(4321)
    spawnMock.mockReturnValue(spawned)
    const kill = alive(4321)

    const first = await startWatcherDaemon("/app/dist/index.js")
    const second = await startWatcherDaemon("/app/dist/index.js")

    expect([first, second]).toEqual([4321, 4321])
    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(spawnMock.mock.calls[0]?.[1]).toEqual(["/app/dist/index.js", "watch", "--foreground"])
    expect(spawned.unref).toHaveBeenCalled()
    expect(await readFile(join(home, "watch.pid"), "utf8")).toBe("4321")
    expect((await stat(join(home, "watch.pid"))).mode & 0o777).toBe(0o600)
    kill.mockRestore()
  })

  test("concurrent starts spawn exactly one daemon", async () => {
    const home = await useHome()
    const spawned = child(4321)
    spawnMock.mockReturnValue(spawned)
    const kill = alive(4321)

    const results = await Promise.all(
      Array.from({ length: 5 }, () => startWatcherDaemon("/app/dist/index.js")),
    )

    expect(results).toEqual([4321, 4321, 4321, 4321, 4321])
    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(await readFile(join(home, "watch.pid"), "utf8")).toBe("4321")
    kill.mockRestore()
  })

  test("the lock is released after the action throws, so a later start still works", async () => {
    await useHome()
    spawnMock.mockReturnValueOnce(child(undefined)).mockReturnValueOnce(child(777))
    const kill = alive(777)

    await expect(startWatcherDaemon("/app/dist/index.js")).rejects.toThrow(
      "failed to spawn watcher daemon",
    )
    await expect(startWatcherDaemon("/app/dist/index.js")).resolves.toBe(777)
    kill.mockRestore()
  })

  test("the spawned daemon is marked so it logs to files rather than inherited stdio", async () => {
    await useHome()
    spawnMock.mockReturnValue(child(4321))
    alive(4321)

    await startWatcherDaemon("/app/dist/index.js")

    const env = spawnMock.mock.calls[0]?.[2]?.env as NodeJS.ProcessEnv
    expect(env.SAMSKARA_DAEMON).toBe("1")
  })

  test("EDGE-007: stale PID state is removed and reported stopped", async () => {
    const home = await useHome()
    await writeFile(join(home, "watch.pid"), "9999", "utf8")
    alive()

    expect(watcherPid()).toBeNull()
    await expect(readFile(join(home, "watch.pid"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    })
  })

  test("concurrent startup rechecks PID state after acquiring the start lock", async () => {
    const home = await useHome()
    alive(777)
    // A competing process wins the lock and records its PID first.
    writeFileSync(join(home, "watch.pid"), "777", { mode: 0o600 })

    await expect(startWatcherDaemon("/app/dist/index.js")).resolves.toBe(777)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  test("PID persistence failure terminates the spawned watcher before returning an error", async () => {
    const home = await useHome()
    const spawned = child(444)
    spawnMock.mockReturnValue(spawned)
    alive()
    // Make the PID path unwritable by turning it into a directory.
    const { mkdir } = await import("node:fs/promises")
    await mkdir(join(home, "watch.pid"), { recursive: true })

    await expect(startWatcherDaemon("/app/dist/index.js")).rejects.toThrow()
    expect(spawned.kill).toHaveBeenCalledWith("SIGTERM")
    expect(spawned.unref).not.toHaveBeenCalled()
  })

  test("a watcher that fails to spawn is reported as an error", async () => {
    await useHome()
    const spawned = child(undefined)
    spawnMock.mockReturnValue(spawned)
    alive()

    await expect(startWatcherDaemon("/app/dist/index.js")).rejects.toThrow(
      "failed to spawn watcher daemon",
    )
    expect(spawned.kill).toHaveBeenCalledWith("SIGTERM")
  })

  test("REQ-015: stopping terminates the process and removes its PID file", async () => {
    const home = await useHome()
    await writeFile(join(home, "watch.pid"), "777", "utf8")
    let running = true
    const signals: Array<string | number> = []
    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal: string | number) => {
      if (signal === 0) {
        if (!running) throw new Error("ESRCH")
        return true
      }
      signals.push(signal)
      running = false
      return true
    }) as never)

    const stopped = await stopWatcherDaemon()

    expect(stopped).toBe(true)
    expect(signals).toEqual(["SIGTERM"])
    await expect(readFile(join(home, "watch.pid"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    })
  })

  test("a watcher that ignores SIGTERM is escalated to SIGKILL", async () => {
    const home = await useHome()
    await writeFile(join(home, "watch.pid"), "777", "utf8")
    const signals: Array<string | number> = []
    vi.spyOn(process, "kill").mockImplementation(((_pid: number, signal: string | number) => {
      if (signal === 0) return true
      signals.push(signal)
      return true
    }) as never)
    vi.useFakeTimers()

    const stopped = stopWatcherDaemon()
    await vi.runAllTimersAsync()

    expect(await stopped).toBe(true)
    expect(signals).toEqual(["SIGTERM", "SIGKILL"])
    vi.useRealTimers()
  })
})
