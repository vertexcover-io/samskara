import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { resolveCliEntry } from "../config/daemon.js"
import { installHooksCommand, uninstallHooksCommand } from "./install-hooks.js"

const settingsFile = async (): Promise<string> =>
  join(await mkdtemp(join(tmpdir(), "samskara-hooks-")), ".claude", "settings.json")

const managedCommandIn = (text: string): string => {
  const found = JSON.parse(text)
    .hooks.SessionStart.flatMap(
      (matcher: { hooks: ReadonlyArray<{ command?: string }> }) => matcher.hooks,
    )
    .find((hook: { command?: string }) => hook.command?.includes("samskara:ensure"))
  if (!found?.command) throw new Error("no managed hook found")
  return found.command
}

const entryIn = (command: string): string => {
  const quoted = command.match(/"([^"]+)"/g)
  if (!quoted?.[1]) throw new Error(`no entry path in ${command}`)
  return JSON.parse(quoted[1])
}

describe("hook commands", () => {
  test("Codex hooks preserve other handlers and include profile and stdin routing", async () => {
    const path = await settingsFile()
    installHooksCommand({ settingsPath: path, agent: "codex" })
    const initial = JSON.parse(await readFile(path, "utf8"))
    initial.hooks.Stop = [{ hooks: [{ type: "command", command: "echo unrelated" }] }]
    await writeFile(path, JSON.stringify(initial))
    expect(installHooksCommand({ settingsPath: path, agent: "codex" })).toBe(0)
    const saved = await readFile(path, "utf8")
    expect(saved.match(/samskara:ensure/g)).toHaveLength(1)
    expect(saved).toContain("ensure --agent codex")
    expect(saved).toContain("echo unrelated")
    expect(uninstallHooksCommand({ settingsPath: path, agent: "codex" })).toBe(0)
    expect(await readFile(path, "utf8")).toContain("echo unrelated")
    expect(await readFile(path, "utf8")).not.toContain("samskara:ensure")
  })
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

  test("EDGE-017: reinstalling repairs a managed hook whose entry path went stale", async () => {
    const path = await settingsFile()
    installHooksCommand({ settingsPath: path, stdout: { write: () => undefined } })
    const stale = JSON.parse(await readFile(path, "utf8"))
    stale.hooks.SessionStart.unshift({ hooks: [{ type: "command", command: "echo unrelated" }] })
    stale.hooks.SessionStart.at(-1).hooks[0].command =
      `"/nope/node" "/nope/packages/cli/src/index.js" ensure # samskara:ensure`
    await writeFile(path, JSON.stringify(stale), "utf8")
    const output: string[] = []

    const code = installHooksCommand({
      settingsPath: path,
      stdout: { write: (text) => output.push(text) },
    })

    const text = await readFile(path, "utf8")
    expect(code).toBe(0)
    expect(text).not.toContain("/nope/")
    expect(text.match(/samskara:ensure/g)).toHaveLength(1)
    expect(existsSync(entryIn(managedCommandIn(text)))).toBe(true)
    expect(text).toContain("echo unrelated")
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

describe("OpenCode plugin", () => {
  const pluginFile = async (): Promise<string> =>
    join(await mkdtemp(join(tmpdir(), "samskara-opencode-")), "plugins", "samskara.js")
  const opencode = (settingsPath: string, output: string[] = []) => ({
    agent: "opencode",
    settingsPath,
    stdout: { write: (text: string) => output.push(text) },
    stderr: { write: (text: string) => output.push(text) },
  })

  test("installs a managed plugin that runs ensure from the session's directory", async () => {
    const path = await pluginFile()
    const output: string[] = []

    expect(installHooksCommand(opencode(path, output))).toBe(0)
    expect(installHooksCommand(opencode(path, output))).toBe(0)

    const source = await readFile(path, "utf8")
    expect(source.split("\n")[0]).toBe("// samskara:ensure")
    expect(source).toContain(JSON.stringify(process.execPath))
    expect(source).toContain(JSON.stringify(resolveCliEntry()))
    expect(source).toContain('"session.created"')
    expect(output.join("")).toContain("installed OpenCode plugin")
    expect(output.join("")).toContain("plugin already installed")
    const plugin = await import(path)
    expect(Object.values(plugin).every((value) => typeof value === "function")).toBe(true)
  })

  test("repairs a managed plugin whose entry path went stale", async () => {
    const path = await pluginFile()
    installHooksCommand(opencode(path))
    await writeFile(path, `// samskara:ensure\nspawn("/nope/node")\n`, "utf8")

    expect(installHooksCommand(opencode(path))).toBe(0)
    expect(await readFile(path, "utf8")).not.toContain("/nope/")
  })

  test("never overwrites or removes a plugin it did not write", async () => {
    const path = await pluginFile()
    installHooksCommand(opencode(path))
    await writeFile(path, "export const Mine = async () => ({})\n", "utf8")
    const output: string[] = []

    expect(installHooksCommand(opencode(path, output))).toBe(1)
    expect(uninstallHooksCommand(opencode(path, output))).toBe(1)
    expect(await readFile(path, "utf8")).toBe("export const Mine = async () => ({})\n")
    expect(output.join("")).toContain("not managed by samskara")
  })

  test("uninstall deletes only the managed plugin file", async () => {
    const path = await pluginFile()
    installHooksCommand(opencode(path))

    expect(uninstallHooksCommand(opencode(path))).toBe(0)
    expect(existsSync(path)).toBe(false)
    expect(uninstallHooksCommand(opencode(path))).toBe(0)
  })

  test("a non-default profile travels inside the plugin", async () => {
    const original = process.env.SAMSKARA_PROFILE
    process.env.SAMSKARA_PROFILE = "dev"
    try {
      const path = await pluginFile()
      installHooksCommand(opencode(path))
      const source = await readFile(path, "utf8")
      expect(source.split("\n")[0]).toBe("// samskara:ensure:dev")
      expect(source).toContain('SAMSKARA_PROFILE: "dev"')
    } finally {
      if (original === undefined) delete process.env.SAMSKARA_PROFILE
      else process.env.SAMSKARA_PROFILE = original
    }
  })

  test("the default plugin pins the default profile so a dev shell cannot redirect it", async () => {
    const path = await pluginFile()
    installHooksCommand(opencode(path))
    expect(await readFile(path, "utf8")).toContain('SAMSKARA_PROFILE: "default"')
  })

  test("uninstall reports a filesystem error instead of throwing", async () => {
    const path = await pluginFile()
    await mkdir(path, { recursive: true })
    const output: string[] = []

    expect(uninstallHooksCommand(opencode(path, output))).toBe(1)
    expect(output.join("")).toContain("EISDIR")
  })

  test("rejects an unknown agent and names opencode as an option", () => {
    const output: string[] = []
    expect(installHooksCommand({ agent: "cursor", stderr: { write: (t) => output.push(t) } })).toBe(
      1,
    )
    expect(output.join("")).toContain("claude, codex, opencode, or all")
  })
})

const managedCommandsIn = (text: string): ReadonlyArray<string> =>
  JSON.parse(text)
    .hooks.SessionStart.flatMap(
      (matcher: { hooks: ReadonlyArray<{ command?: string }> }) => matcher.hooks,
    )
    .map((hook: { command?: string }) => hook.command)
    .filter(
      (command: string | undefined): command is string =>
        command?.includes("samskara:ensure") === true,
    )

describe("hook profiles", () => {
  const quiet = { write: () => undefined }
  const originalProfile = process.env.SAMSKARA_PROFILE

  const withProfile = (value: string | undefined): void => {
    if (value === undefined) delete process.env.SAMSKARA_PROFILE
    else process.env.SAMSKARA_PROFILE = value
  }

  const install = (path: string, value: string | undefined): number => {
    withProfile(value)
    return installHooksCommand({ settingsPath: path, stdout: quiet })
  }

  afterEach(() => {
    withProfile(originalProfile)
  })

  test("a dev install and a prod install keep separate hooks instead of overwriting each other", async () => {
    const path = await settingsFile()

    expect(install(path, undefined)).toBe(0)
    const prodCommand = managedCommandIn(await readFile(path, "utf8"))
    expect(install(path, "dev")).toBe(0)

    // Both lines survive: the dev install must not read prod's hook as its own stale one.
    const afterDev = managedCommandsIn(await readFile(path, "utf8"))
    expect(afterDev).toHaveLength(2)
    expect(afterDev).toContain(prodCommand)
    // Claude Code runs the hook without the dev shell, so the profile rides in the command itself.
    expect(afterDev.filter((command) => command.startsWith("SAMSKARA_PROFILE=dev "))).toHaveLength(
      1,
    )

    // `samskara:ensure` is a prefix of `samskara:ensure:dev`, so a substring match here would let
    // the prod install swallow the dev hook on the very next `samskara init`.
    expect(install(path, undefined)).toBe(0)
    expect(managedCommandsIn(await readFile(path, "utf8"))).toEqual(afterDev)

    // Removing one profile leaves the other capturing.
    withProfile("dev")
    expect(uninstallHooksCommand({ settingsPath: path, stdout: quiet })).toBe(0)
    expect(managedCommandsIn(await readFile(path, "utf8"))).toEqual([prodCommand])
  })
})
