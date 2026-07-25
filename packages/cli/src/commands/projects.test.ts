import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ProjectIdentity } from "@samskara/core"
import { afterEach, describe, expect, test } from "vitest"
import { getProject, upsertProject } from "../config/projects.js"
import { disableCommand } from "./disable.js"
import { enableCommand } from "./enable.js"

const originalHome = process.env.SAMSKARA_HOME

const setup = async (): Promise<{ readonly home: string; readonly output: string[] }> => {
  const home = await mkdtemp(join(tmpdir(), "samskara-command-projects-"))
  process.env.SAMSKARA_HOME = home
  return { home, output: [] }
}

const identity: ProjectIdentity = { name: "widget", slug: "acme-widget" }

afterEach(() => {
  process.env.SAMSKARA_HOME = originalHome
})

describe("enable command", () => {
  test("REQ-006,REQ-008: defaults to cwd and stores an absolute project path", async () => {
    const { output } = await setup()
    const seen: string[] = []

    const code = await enableCommand({
      cwd: "/work/widget",
      now: () => new Date("2026-07-25T10:00:00.000Z"),
      resolveProject: async (path) => {
        seen.push(path)
        return identity
      },
      stdout: { write: (text) => output.push(text) },
    })

    expect(code).toBe(0)
    expect(seen).toEqual(["/work/widget"])
    expect(await getProject("acme-widget")).toEqual({
      name: "widget",
      path: "/work/widget",
      enabled: true,
      enabledAt: "2026-07-25T10:00:00.000Z",
    })
    expect(output.join("")).toContain("enabled: acme-widget")
  })

  test("EDGE-003: normalizes a relative non-git path before resolving", async () => {
    const { output } = await setup()
    const seen: string[] = []

    await enableCommand({
      path: "nested",
      cwd: "/work",
      resolveProject: async (path) => {
        seen.push(path)
        return { name: "nested", slug: "-work-nested" }
      },
      stdout: { write: (text) => output.push(text) },
    })

    expect(seen).toEqual(["/work/nested"])
    expect((await getProject("-work-nested"))?.path).toBe("/work/nested")
  })
})

describe("disable command", () => {
  test("REQ-010: disables a registered project without deleting its metadata", async () => {
    const { output } = await setup()
    await upsertProject("acme-widget", {
      name: "widget",
      path: "/work/widget",
      enabled: true,
      enabledAt: "2026-07-25T10:00:00.000Z",
    })

    const code = await disableCommand({
      cwd: "/work/widget",
      resolveProject: async () => identity,
      stdout: { write: (text) => output.push(text) },
    })

    expect(code).toBe(0)
    expect(await getProject("acme-widget")).toEqual({
      name: "widget",
      path: "/work/widget",
      enabled: false,
      enabledAt: "2026-07-25T10:00:00.000Z",
    })
    expect(output.join("")).toContain("disabled: acme-widget")
  })

  test("REQ-011,EDGE-005: unknown and already-disabled projects succeed idempotently", async () => {
    const { output } = await setup()

    const first = await disableCommand({
      path: "/work/missing",
      resolveProject: async () => identity,
      stdout: { write: (text) => output.push(text) },
    })
    const second = await disableCommand({
      path: "/work/missing",
      resolveProject: async () => identity,
      stdout: { write: (text) => output.push(text) },
    })

    expect([first, second]).toEqual([0, 0])
    expect(await getProject("acme-widget")).toBeNull()
    expect(output.join("").match(/disabled: acme-widget/g)).toHaveLength(2)
  })
})
