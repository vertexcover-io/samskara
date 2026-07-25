import type { ProjectIdentity } from "@samskara/core"
import { describe, expect, test } from "vitest"
import { ensureCommand } from "./ensure.js"

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

describe("ensure command", () => {
  test("REQ-021: missing credentials emit login guidance without starting a watcher", async () => {
    const streams = output()
    let revived = false

    const code = await ensureCommand({
      readToken: async () => null,
      reviveWatcher: () => {
        revived = true
        return 1
      },
      ...streams.writers,
    })

    expect(code).toBe(0)
    expect(revived).toBe(false)
    expect(streams.stdout.join("")).toContain('"hookEventName":"SessionStart"')
    expect(streams.stdout.join("")).toContain("samskara login")
  })

  test("REQ-022: authenticated ensure revives a dead watcher", async () => {
    const streams = output()
    let livePid: number | null = null

    const code = await ensureCommand({
      readToken: async () => "token",
      watcherPid: () => livePid,
      reviveWatcher: () => {
        livePid = 321
        return livePid
      },
      resolveProject: async () => project,
      isProjectEnabled: async () => true,
      ...streams.writers,
    })

    expect(code).toBe(0)
    expect(livePid).toBe(321)
    expect(streams.stdout).toEqual([])
  })

  test("REQ-023,EDGE-008: immediate daemon death emits fail-open capture guidance", async () => {
    const streams = output()

    const code = await ensureCommand({
      readToken: async () => "token",
      watcherPid: () => null,
      reviveWatcher: () => 321,
      resolveProject: async () => project,
      isProjectEnabled: async () => true,
      ...streams.writers,
    })

    expect(code).toBe(0)
    expect(streams.stdout.join("")).toContain("capture may be OFF")
    expect(streams.stdout.join("")).toContain("watch.log")
  })

  test("REQ-024: inactive current folder emits enable guidance", async () => {
    const streams = output()

    const code = await ensureCommand({
      cwd: "/work/widget",
      readToken: async () => "token",
      watcherPid: () => 321,
      resolveProject: async () => project,
      isProjectEnabled: async () => false,
      ...streams.writers,
    })

    expect(code).toBe(0)
    expect(streams.stdout.join("")).toContain("acme-widget")
    expect(streams.stdout.join("")).toContain("samskara enable")
  })

  test("REQ-025: unexpected failures never block SessionStart", async () => {
    const streams = output()

    const code = await ensureCommand({
      readToken: async () => {
        throw new Error("disk unavailable")
      },
      ...streams.writers,
    })

    expect(code).toBe(0)
    expect(streams.stderr.join("")).toContain("disk unavailable")
  })
})
