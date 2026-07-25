import { describe, expect, test } from "vitest"
import { initCommand } from "./init.js"

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

describe("init command", () => {
  test("REQ-001,REQ-003,REQ-004: pairs, installs the hook, and starts the watcher", async () => {
    const streams = output()
    let token: string | null = null
    let hooks = 0
    let starts = 0

    const code = await initCommand({
      readToken: async () => token,
      login: async () => {
        token = "paired-token"
        return 0
      },
      hookInstalled: () => false,
      installHooks: () => {
        hooks += 1
        return 0
      },
      watcherPid: () => null,
      startWatcher: () => {
        starts += 1
        return 444
      },
      ...streams.writers,
    })

    expect(code).toBe(0)
    expect({ hooks, starts }).toEqual({ hooks: 1, starts: 1 })
    expect(streams.stdout.join("")).toContain("started watcher (pid 444)")
  })

  test("EDGE-001: failed pairing does not install hooks or start a daemon", async () => {
    let hooks = 0
    let starts = 0

    const code = await initCommand({
      readToken: async () => null,
      login: async () => 1,
      hookInstalled: () => false,
      installHooks: () => {
        hooks += 1
        return 0
      },
      watcherPid: () => null,
      startWatcher: () => {
        starts += 1
        return 1
      },
    })

    expect(code).toBe(1)
    expect({ hooks, starts }).toEqual({ hooks: 0, starts: 0 })
  })

  test("REQ-002,REQ-005,EDGE-002: complete setup is idempotent", async () => {
    const streams = output()
    let starts = 0

    const code = await initCommand({
      readToken: async () => "token",
      login: async () => 1,
      hookInstalled: () => true,
      installHooks: () => 0,
      watcherPid: () => 777,
      startWatcher: () => {
        starts += 1
        return 888
      },
      ...streams.writers,
    })

    expect(code).toBe(0)
    expect(starts).toBe(0)
    expect(streams.stdout.join("")).toContain("already logged in")
    expect(streams.stdout.join("")).toContain("nothing to do.")
  })
})
