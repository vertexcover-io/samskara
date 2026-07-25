import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { upsertProject } from "../config/projects.js"
import { statusCommand } from "./status.js"

const originalHome = process.env.SAMSKARA_HOME

afterEach(() => {
  process.env.SAMSKARA_HOME = originalHome
})

describe("status command", () => {
  test("REQ-012,REQ-013,EDGE-006: lists all projects and the latest checkpoint for each slug", async () => {
    const home = await mkdtemp(join(tmpdir(), "samskara-status-"))
    process.env.SAMSKARA_HOME = home
    await upsertProject("acme-widget", {
      name: "widget",
      path: "/work/widget",
      enabled: true,
      enabledAt: "2026-07-25T09:00:00.000Z",
    })
    await upsertProject("acme-off", {
      name: "off",
      path: "/work/off",
      enabled: false,
      enabledAt: "2026-07-25T08:00:00.000Z",
    })
    await writeFile(
      join(home, "state.json"),
      JSON.stringify({
        checkpoints: {
          a: {
            filePath: "a",
            lastUpdatedAt: "2026-07-25T10:00:00.000Z",
            projectSlug: "acme-widget",
            source: "claude_code",
            mtime: 1,
            size: 1,
            lineProcessed: 1,
          },
          b: {
            filePath: "b",
            lastUpdatedAt: "2026-07-25T11:00:00.000Z",
            projectSlug: "acme-widget",
            source: "claude_code",
            mtime: 1,
            size: 1,
            lineProcessed: 1,
          },
        },
      }),
      "utf8",
    )
    const output: string[] = []

    const code = await statusCommand({
      watcherPid: () => 123,
      stdout: { write: (text) => output.push(text) },
    })
    const text = output.join("")

    expect(code).toBe(0)
    expect(text).toContain("acme-widget")
    expect(text).toContain("/work/widget")
    expect(text).toContain("2026-07-25T11:00:00.000Z")
    expect(text).toContain("acme-off")
    expect(text).toMatch(/acme-off.*disabled.*-/)
    expect(text).toContain("watcher: running (pid 123)")
    expect(text).toContain(join(home, "watch.log"))
  })

  test("REQ-012,REQ-014: empty registry reports an empty state and stopped watcher", async () => {
    process.env.SAMSKARA_HOME = await mkdtemp(join(tmpdir(), "samskara-status-empty-"))
    const output: string[] = []

    const code = await statusCommand({
      watcherPid: () => null,
      stdout: { write: (text) => output.push(text) },
    })

    expect(code).toBe(0)
    expect(output.join("")).toContain("No projects registered.")
    expect(output.join("")).toContain("watcher: stopped")
  })
})
