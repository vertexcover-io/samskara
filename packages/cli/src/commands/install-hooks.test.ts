import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { resolveCliEntry } from "../config/daemon.js"
import { installHooksCommand, uninstallHooksCommand } from "./install-hooks.js"

const settingsFile = async (): Promise<string> =>
  join(await mkdtemp(join(tmpdir(), "samskara-hooks-")), ".claude", "settings.json")

describe("hook commands", () => {
  test("REQ-018,EDGE-015: installs one absolute managed SessionStart hook idempotently", async () => {
    const path = await settingsFile()
    const output: string[] = []

    const first = installHooksCommand({
      settingsPath: path,
      stdout: { write: (text) => output.push(text) },
    })
    const second = installHooksCommand({
      settingsPath: path,
      stdout: { write: (text) => output.push(text) },
    })

    expect([first, second]).toEqual([0, 0])
    const text = await readFile(path, "utf8")
    expect(text.match(/samskara:ensure/g)).toHaveLength(1)
    expect(text).toContain(process.execPath)
    expect(text).toContain(resolveCliEntry())
  })

  test("REQ-019: uninstall removes only the managed hook", async () => {
    const path = await settingsFile()
    installHooksCommand({ settingsPath: path })
    const installed: unknown = JSON.parse(await readFile(path, "utf8"))
    await writeFile(
      path,
      JSON.stringify({
        theme: "dark",
        hooks: {
          SessionStart: [
            { hooks: [{ type: "command", command: "echo unrelated" }] },
            ...(typeof installed === "object" &&
            installed !== null &&
            "hooks" in installed &&
            typeof installed.hooks === "object" &&
            installed.hooks !== null &&
            "SessionStart" in installed.hooks &&
            Array.isArray(installed.hooks.SessionStart)
              ? installed.hooks.SessionStart
              : []),
          ],
        },
      }),
      "utf8",
    )

    const code = uninstallHooksCommand({ settingsPath: path })
    const text = await readFile(path, "utf8")

    expect(code).toBe(0)
    expect(text).not.toContain("samskara:ensure")
    expect(text).toContain("echo unrelated")
    expect(text).toContain('"theme": "dark"')
  })

  test.each([
    ["invalid JSON", "{broken"],
    [
      "malformed structured SessionStart hooks",
      JSON.stringify({
        hooks: {
          SessionStart: [
            { hooks: [{ type: "command", command: "keep-me" }] },
            { hooks: "not-an-array" },
          ],
        },
      }),
    ],
    [
      "a SessionStart matcher without a hooks array",
      JSON.stringify({ hooks: { SessionStart: [{ matcher: "startup", note: "keep-me" }] } }),
    ],
  ])("EDGE-009: %s fail without being overwritten", async (_case, contents) => {
    const path = await settingsFile()
    const { mkdir } = await import("node:fs/promises")
    const { dirname } = await import("node:path")
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, contents, "utf8")
    const errors: string[] = []

    const installCode = installHooksCommand({
      settingsPath: path,
      stderr: { write: (text) => errors.push(text) },
    })
    const uninstallCode = uninstallHooksCommand({
      settingsPath: path,
      stderr: { write: (text) => errors.push(text) },
    })

    expect([installCode, uninstallCode]).toEqual([1, 1])
    expect(await readFile(path, "utf8")).toBe(contents)
  })
})
