import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { readToken } from "../config/credentials.js"
import { startWatcherDaemon, watcherPid } from "../config/daemon.js"
import { readSettings, writeSettings } from "../config/settings.js"
import { apiBase, webBase } from "../config.js"
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

const originalEnv = {
  home: process.env.SAMSKARA_HOME,
  api: process.env.SAMSKARA_API_URL,
  web: process.env.SAMSKARA_WEB_URL,
}

const restore = (key: string, value: string | undefined): void => {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

afterEach(() => {
  restore("SAMSKARA_HOME", originalEnv.home)
  restore("SAMSKARA_API_URL", originalEnv.api)
  restore("SAMSKARA_WEB_URL", originalEnv.web)
})

beforeEach(async () => {
  process.env.SAMSKARA_HOME = await mkdtemp(join(tmpdir(), "samskara-init-"))
  delete process.env.SAMSKARA_API_URL
  delete process.env.SAMSKARA_WEB_URL

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

describe("init server url", () => {
  const answers = (...replies: ReadonlyArray<string>) => {
    const asked: string[] = []
    let next = 0
    return {
      asked,
      prompt: async (question: string, fallback: string) => {
        asked.push(`${question}|${fallback}`)
        return replies[next++] ?? ""
      },
    }
  }

  test("asks for both urls and offers localhost as the default", async () => {
    const streams = output()
    const ask = answers("", "")

    const code = await initCommand({ ...streams.writers, prompt: ask.prompt })

    expect(code).toBe(0)
    expect(ask.asked).toHaveLength(2)
    expect(ask.asked[0]).toContain("|http://localhost:3000")
    expect(ask.asked[1]).toContain("|http://localhost:8000")
    expect(readSettings()).toEqual({
      version: 1,
      apiUrl: "http://localhost:3000",
      webUrl: "http://localhost:8000",
    })
  })

  test("saves a different server and every later call uses it", async () => {
    const streams = output()
    const ask = answers("https://samskara.acme.dev/", "https://app.acme.dev")

    const code = await initCommand({ ...streams.writers, prompt: ask.prompt })

    expect(code).toBe(0)
    expect(apiBase()).toBe("https://samskara.acme.dev")
    expect(webBase()).toBe("https://app.acme.dev")
  })

  test("the saved url becomes the default the next time init runs", async () => {
    await writeSettings({ apiUrl: "http://box:3000", webUrl: "http://box:8000" })
    const ask = answers("", "")

    await initCommand({ ...output().writers, prompt: ask.prompt })

    expect(ask.asked[0]).toContain("|http://box:3000")
    expect(readSettings()?.apiUrl).toBe("http://box:3000")
  })

  test("--server and --web skip the prompt", async () => {
    const ask = answers()

    const code = await initCommand({
      ...output().writers,
      prompt: ask.prompt,
      server: "http://box:3000",
      web: "http://box:8000",
    })

    expect(code).toBe(0)
    expect(ask.asked).toHaveLength(0)
    expect(readSettings()?.apiUrl).toBe("http://box:3000")
  })

  test("re-asks after a url that cannot be used", async () => {
    const streams = output()
    const ask = answers("not a url", "http://box:3000", "http://box:8000")

    const code = await initCommand({ ...streams.writers, prompt: ask.prompt })

    expect(code).toBe(0)
    expect(readSettings()?.apiUrl).toBe("http://box:3000")
    expect(streams.stderr.join("")).toContain("not a url")
  })

  test("gives up rather than looping forever on a stream of bad urls", async () => {
    const ask = answers("not a url", "also bad", "still bad", "http://box:3000")

    const code = await initCommand({ ...output().writers, prompt: ask.prompt })

    expect(code).toBe(1)
  })

  test("SAMSKARA_API_URL wins, so init neither asks nor overwrites it", async () => {
    process.env.SAMSKARA_API_URL = "http://fromenv:3000"
    const streams = output()
    const ask = answers("http://box:8000")

    const code = await initCommand({ ...streams.writers, prompt: ask.prompt })

    expect(code).toBe(0)
    expect(ask.asked).toHaveLength(1)
    expect(ask.asked[0]).toContain("|http://localhost:8000")
    expect(streams.stdout.join("")).toContain("SAMSKARA_API_URL")
    expect(apiBase()).toBe("http://fromenv:3000")
  })

  test("without a prompt it keeps what is saved instead of hanging on a dead stdin", async () => {
    await writeSettings({ apiUrl: "http://box:3000", webUrl: "http://box:8000" })

    const code = await initCommand(output().writers)

    expect(code).toBe(0)
    expect(readSettings()?.apiUrl).toBe("http://box:3000")
  })
})
