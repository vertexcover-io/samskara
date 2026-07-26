import { beforeEach, describe, expect, test, vi } from "vitest"
import { readToken } from "../config/credentials.js"
import { startWatcherDaemon, watcherPid } from "../config/daemon.js"
import { login } from "../login.js"
import { initCommand } from "./init.js"
import { installHooksCommand, isManagedHookInstalled } from "./install-hooks.js"

vi.mock("../config/credentials.js", () => ({ readToken: vi.fn() }))
vi.mock("../config/daemon.js", () => ({
  startWatcherDaemon: vi.fn(() => 444),
  watcherPid: vi.fn(() => null),
}))
vi.mock("../login.js", () => ({ login: vi.fn(async () => 0) }))
vi.mock("./install-hooks.js", () => ({
  installHooksCommand: vi.fn(() => 0),
  isManagedHookInstalled: vi.fn(() => false),
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

/** In-memory stand-in for the machine state init mutates: credentials, hook, daemon. */
const world = {
  token: null as string | null,
  hookInstalled: false,
  runningPid: null as number | null,
}

beforeEach(() => {
  world.token = null
  world.hookInstalled = false
  world.runningPid = null

  vi.mocked(readToken).mockImplementation(async () => world.token)
  vi.mocked(login).mockImplementation(async () => {
    world.token = "paired-token"
    return 0
  })
  vi.mocked(isManagedHookInstalled).mockImplementation(() => world.hookInstalled)
  vi.mocked(installHooksCommand).mockImplementation(() => {
    world.hookInstalled = true
    return 0
  })
  vi.mocked(watcherPid).mockImplementation(() => world.runningPid)
  vi.mocked(startWatcherDaemon).mockImplementation(async () => {
    world.runningPid = 444
    return 444
  })
})

describe("init command", () => {
  test("REQ-001,REQ-003,REQ-004: pairs, installs the hook, and starts the watcher", async () => {
    const streams = output()

    const code = await initCommand(streams.writers)

    expect(code).toBe(0)
    expect(world.hookInstalled).toBe(true)
    expect(world.runningPid).toBe(444)
  })

  test("EDGE-001: failed pairing leaves the hook uninstalled and no daemon running", async () => {
    vi.mocked(login).mockResolvedValue(1)

    const code = await initCommand()

    expect(code).toBe(1)
    expect(world.hookInstalled).toBe(false)
    expect(world.runningPid).toBeNull()
  })

  test("REQ-002,REQ-005,EDGE-002: complete setup is idempotent", async () => {
    const streams = output()
    world.token = "token"
    world.hookInstalled = true
    world.runningPid = 777

    const code = await initCommand(streams.writers)

    expect(code).toBe(0)
    expect(world.runningPid).toBe(777)
  })

  test("a watcher that cannot start fails init instead of reporting success", async () => {
    const streams = output()
    world.token = "token"
    vi.mocked(startWatcherDaemon).mockImplementation(() => {
      throw new Error("failed to spawn watcher daemon")
    })

    const code = await initCommand(streams.writers)

    expect(code).toBe(1)
    expect(streams.stderr.length).toBeGreaterThan(0)
  })
})
