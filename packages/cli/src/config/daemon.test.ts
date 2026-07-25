import { writeFileSync } from "node:fs"
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { type SpawnWatcher, startWatcherDaemon, stopWatcherDaemon, watcherPid } from "./daemon.js"

const originalHome = process.env.SAMSKARA_HOME

const useHome = async (): Promise<string> => {
  const home = await mkdtemp(join(tmpdir(), "samskara-daemon-"))
  process.env.SAMSKARA_HOME = home
  return home
}

afterEach(() => {
  process.env.SAMSKARA_HOME = originalHome
})

describe("watcher daemon", () => {
  test("REQ-020: starts a detached singleton and persists its PID at 0600", async () => {
    const home = await useHome()
    const spawns: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = []
    let unreferenced = false
    const spawn: SpawnWatcher = (command, args) => {
      spawns.push({ command, args })
      return {
        pid: 4321,
        unref: () => {
          unreferenced = true
        },
        kill: () => true,
      }
    }

    const first = startWatcherDaemon({
      cliEntry: "/app/dist/index.js",
      nodeBin: "/usr/bin/node",
      spawn,
      isProcessAlive: () => false,
    })
    const second = startWatcherDaemon({
      cliEntry: "/app/dist/index.js",
      nodeBin: "/usr/bin/node",
      spawn,
      isProcessAlive: (pid) => pid === 4321,
    })

    expect([first, second]).toEqual([4321, 4321])
    expect(spawns).toEqual([{ command: "/usr/bin/node", args: ["/app/dist/index.js", "watch"] }])
    expect(unreferenced).toBe(true)
    expect(await readFile(join(home, "watch.pid"), "utf8")).toBe("4321")
    expect((await stat(join(home, "watch.pid"))).mode & 0o777).toBe(0o600)
    expect((await stat(join(home, "watch.log"))).isFile()).toBe(true)
  })

  test("EDGE-007: stale PID state is removed and reported stopped", async () => {
    const home = await useHome()
    await writeFile(join(home, "watch.pid"), "9999", "utf8")

    const pid = watcherPid({ isProcessAlive: () => false })

    expect(pid).toBeNull()
    await expect(readFile(join(home, "watch.pid"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    })
  })

  test("concurrent startup rechecks PID state after acquiring the start lock", async () => {
    const home = await useHome()
    let spawns = 0

    const pid = startWatcherDaemon({
      cliEntry: "/app/dist/index.js",
      spawn: () => {
        spawns += 1
        return { pid: 888, unref: () => undefined, kill: () => true }
      },
      isProcessAlive: (candidate) => candidate === 777,
      withStartLock: (action) => {
        writeFileSync(join(home, "watch.pid"), "777", { mode: 0o600 })
        return action()
      },
    })

    expect(pid).toBe(777)
    expect(spawns).toBe(0)
  })

  test("PID persistence failure terminates the spawned watcher before returning an error", async () => {
    await useHome()
    const signals: string[] = []
    let unreferenced = false

    expect(() =>
      startWatcherDaemon({
        cliEntry: "/app/dist/index.js",
        spawn: () => ({
          pid: 444,
          unref: () => {
            unreferenced = true
          },
          kill: (signal) => {
            signals.push(signal ?? "SIGTERM")
            return true
          },
        }),
        isProcessAlive: () => false,
        persistPid: () => {
          throw new Error("disk full")
        },
      }),
    ).toThrow("disk full")
    expect(signals).toEqual(["SIGTERM"])
    expect(unreferenced).toBe(false)
  })

  test("REQ-015: stopping terminates the process and removes its PID file", async () => {
    const home = await useHome()
    await writeFile(join(home, "watch.pid"), "777", "utf8")
    let alive = true
    const signals: string[] = []

    const stopped = await stopWatcherDaemon({
      isProcessAlive: () => alive,
      kill: (_pid, signal) => {
        signals.push(signal)
        alive = false
      },
      sleep: async () => undefined,
    })

    expect(stopped).toBe(true)
    expect(signals).toEqual(["SIGTERM"])
    await expect(readFile(join(home, "watch.pid"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    })
  })
})
