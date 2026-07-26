import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ProjectIdentity } from "@samskara/core"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { reviveWatcher, watcherPid } from "../config/daemon.js"
import { getProject, upsertProject } from "../config/projects.js"
import { resolveLocalProject } from "../project-resolver.js"
import { disableCommand } from "./disable.js"
import { enableCommand } from "./enable.js"

const originalHome = process.env.SAMSKARA_HOME

const setup = async (): Promise<{ readonly home: string; readonly output: string[] }> => {
  const home = await mkdtemp(join(tmpdir(), "samskara-command-projects-"))
  process.env.SAMSKARA_HOME = home
  return { home, output: [] }
}

vi.mock("../config/daemon.js", () => ({
  reviveWatcher: vi.fn(() => 4321),
  watcherPid: vi.fn(() => 999),
}))
vi.mock("../project-resolver.js", () => ({ resolveLocalProject: vi.fn() }))

const identity: ProjectIdentity = { name: "widget", slug: "acme-widget" }

beforeEach(() => {
  vi.mocked(resolveLocalProject).mockResolvedValue(identity)
  vi.mocked(watcherPid).mockReturnValue(999)
  vi.mocked(reviveWatcher).mockResolvedValue(4321)
})

afterEach(() => {
  process.env.SAMSKARA_HOME = originalHome
})

describe("enable command", () => {
  test.each([
    ["a new project", false, "2026-07-26T18:30:00.000Z"],
    ["an already-enabled project", true, "2026-07-25T10:00:00.000Z"],
    ["a previously-disabled project", "disabled", "2026-07-26T18:30:00.000Z"],
  ])(
    "REQ-006,REQ-008: enabling %s stores an absolute path and the right enabledAt",
    async (_case, priorState, expectedEnabledAt) => {
      const { output } = await setup()
      const stdout = { write: (text: string) => output.push(text) }
      if (priorState) {
        await enableCommand({
          cwd: "/work/widget",
          now: () => new Date("2026-07-25T10:00:00.000Z"),
          stdout,
        })
        if (priorState === "disabled") await disableCommand({ cwd: "/work/widget", stdout })
      }

      const code = await enableCommand({
        cwd: "/work/widget",
        now: () => new Date("2026-07-26T18:30:00.000Z"),
        stdout,
      })

      expect(code).toBe(0)
      expect(await getProject("acme-widget")).toEqual({
        name: "widget",
        path: "/work/widget",
        enabled: true,
        enabledAt: expectedEnabledAt,
      })
    },
  )

  test("EDGE-003: normalizes a relative non-git path before resolving", async () => {
    const { output } = await setup()
    vi.mocked(resolveLocalProject).mockResolvedValue({ name: "nested", slug: "-work-nested" })

    await enableCommand({
      path: "nested",
      cwd: "/work",
      stdout: { write: (text) => output.push(text) },
    })

    expect(resolveLocalProject).toHaveBeenCalledWith("/work/nested")
    expect((await getProject("-work-nested"))?.path).toBe("/work/nested")
  })

  test.each([
    ["a stopped watcher is started", null, 4321, 4321],
    ["a running watcher is left alone", 999, null, 999],
    ["a watcher that will not stay up does not fail enable", null, null, null],
  ])("REQ-007: %s", async (_case, initialPid, revivedPid, expectedPid) => {
    const { output } = await setup()
    const daemon = { runningPid: initialPid as number | null }
    vi.mocked(watcherPid).mockImplementation(() => daemon.runningPid)
    vi.mocked(reviveWatcher).mockImplementation(async () => {
      daemon.runningPid = revivedPid
      return revivedPid
    })

    const code = await enableCommand({
      cwd: "/work/widget",
      stdout: { write: (text) => output.push(text) },
      stderr: { write: () => undefined },
    })

    expect(code).toBe(0)
    expect(daemon.runningPid).toBe(expectedPid)
    expect(await getProject("acme-widget")).toMatchObject({ enabled: true })
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
      stdout: { write: (text) => output.push(text) },
    })

    expect(code).toBe(0)
    expect(await getProject("acme-widget")).toEqual({
      name: "widget",
      path: "/work/widget",
      enabled: false,
      enabledAt: "2026-07-25T10:00:00.000Z",
    })
  })

  test("REQ-011,EDGE-005: unknown and already-disabled projects succeed idempotently", async () => {
    const { output } = await setup()

    const first = await disableCommand({
      path: "/work/missing",
      stdout: { write: (text) => output.push(text) },
    })
    const second = await disableCommand({
      path: "/work/missing",
      stdout: { write: (text) => output.push(text) },
    })

    expect([first, second]).toEqual([0, 0])
    expect(await getProject("acme-widget")).toBeNull()
  })
})
