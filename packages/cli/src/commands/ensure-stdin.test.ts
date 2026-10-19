import { execFile, spawn } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { expect, test } from "vitest"

const exec = promisify(execFile)

test("a real Codex SessionStart pipe reports its project instead of the CLI launch folder", async () => {
  const home = await mkdtemp(join(tmpdir(), "samskara-hook-stdin-"))
  const cwd = join(home, "native-project")
  const launch = join(home, "launch")
  const state = join(home, ".samskara")
  await Promise.all([cwd, launch, state].map((path) => mkdir(path, { recursive: true })))
  await exec("git", ["init", "-q"], { cwd })
  await exec("git", ["remote", "add", "origin", "https://github.com/acme/native-hook.git"], { cwd })
  await writeFile(join(state, "token"), "fixture-token")
  await writeFile(join(state, "watch.pid"), String(process.pid))
  const entry = fileURLToPath(new URL("../index.ts", import.meta.url))
  try {
    const child = spawn("bun", [entry, "ensure", "--agent", "codex"], {
      cwd: launch,
      env: {
        ...process.env,
        HOME: home,
        SAMSKARA_HOME: state,
        SAMSKARA_PROFILE: "default",
        CODEX_HOME: join(home, ".codex"),
        CODEX_SQLITE_HOME: join(home, ".codex"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (value: Buffer) => {
      stdout += value.toString()
    })
    child.stderr.on("data", (value: Buffer) => {
      stderr += value.toString()
    })
    const completed = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject)
      child.once("close", resolve)
    })
    child.stdin.end(
      JSON.stringify({ hook_event_name: "SessionStart", session_id: "native-thread", cwd }),
    )
    expect(await completed).toBe(0)
    expect(stderr).not.toContain("samskara ensure:")
    expect(JSON.parse(stdout)).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: expect.stringContaining("acme-native-hook"),
      },
    })
    expect(stdout).not.toContain(launch)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
