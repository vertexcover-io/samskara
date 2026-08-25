import { beforeEach, describe, expect, test, vi } from "vitest"
import { startWatcherDaemon, watcherPid } from "../config/daemon.js"
import { createWatchLogger } from "../config/log.js"
import { watch } from "../watcher/index.js"
import { watchCommand } from "./watch.js"

vi.mock("../config/daemon.js", () => ({
  startWatcherDaemon: vi.fn(() => 4321),
  watcherPid: vi.fn(() => null),
}))
vi.mock("../watcher/index.js", () => ({ watch: vi.fn(async () => undefined) }))
vi.mock("../config/log.js", () => ({
  createWatchLogger: vi.fn(() => ({ log: {}, ready: async () => undefined })),
}))

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

/** Tracks the daemon state and capture loop the command is supposed to drive. */
const world = {
  runningPid: null as number | null,
  loopRan: false,
  prettyLogs: null as boolean | null,
}

beforeEach(() => {
  world.runningPid = null
  world.loopRan = false
  world.prettyLogs = null
  vi.mocked(createWatchLogger).mockImplementation((options = {}) => {
    world.prettyLogs = Boolean(options.pretty)
    return { log: {} as never, ready: async () => undefined }
  })
  vi.mocked(watcherPid).mockImplementation(() => world.runningPid)
  vi.mocked(startWatcherDaemon).mockImplementation(async () => {
    world.runningPid = 4321
    return 4321
  })
  vi.mocked(watch).mockImplementation(async () => {
    world.loopRan = true
  })
})

describe("watch command", () => {
  test("detaches by default, reporting the daemon pid and log path", async () => {
    const streams = output()

    const code = await watchCommand(streams.writers)

    expect(code).toBe(0)
    expect(world.runningPid).toBe(4321)
    expect(world.loopRan).toBe(false)
  })

  test("an already-running daemon is reported without spawning a second one", async () => {
    const streams = output()
    world.runningPid = 999

    const code = await watchCommand(streams.writers)

    expect(code).toBe(0)
    expect(world.runningPid).toBe(999)
  })

  test("--foreground runs the watch loop in-process instead of detaching", async () => {
    const streams = output()

    const code = await watchCommand({ foreground: true, ...streams.writers })

    expect(code).toBe(0)
    expect(world.loopRan).toBe(true)
    expect(world.runningPid).toBeNull()
    expect(streams.stdout).toEqual([])
  })

  test("the daemon child logs to files while an interactive run pretty-prints", async () => {
    const original = process.env.SAMSKARA_DAEMON
    try {
      process.env.SAMSKARA_DAEMON = "1"
      await watchCommand({ foreground: true, ...output().writers })
      expect(world.prettyLogs).toBe(false)

      process.env.SAMSKARA_DAEMON = undefined
      await watchCommand({ foreground: true, ...output().writers })
      expect(world.prettyLogs).toBe(true)
    } finally {
      process.env.SAMSKARA_DAEMON = original
    }
  })

  test("a failed spawn exits non-zero and leaves no daemon recorded", async () => {
    const streams = output()
    vi.mocked(startWatcherDaemon).mockImplementation(() => {
      throw new Error("failed to spawn watcher daemon")
    })

    const code = await watchCommand(streams.writers)

    expect(code).toBe(1)
    expect(world.runningPid).toBeNull()
    expect(streams.stderr.length).toBeGreaterThan(0)
  })

  test("--foreground surfaces a crashing watch loop as a non-zero exit", async () => {
    const streams = output()
    vi.mocked(watch).mockRejectedValue(new Error("no token found; run `samskara login` first"))

    const code = await watchCommand({ foreground: true, ...streams.writers })

    expect(code).toBe(1)
    expect(streams.stderr.length).toBeGreaterThan(0)
  })
})
