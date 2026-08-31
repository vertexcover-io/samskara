import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createLogger } from "@samskara/core"
import { afterEach, describe, expect, test } from "vitest"
import { MAX_AGENT_LOG_CHARS } from "./agentlog.js"
import {
  buildMsbArgs,
  createClaudeRunner,
  createMsbWrappedRunner,
  createOpencodeRunner,
} from "./runner.js"

const log = () => createLogger({ service: "samskara-server-test" }, { level: "silent" })

/** Restored after each test that repoints HOME at a scratch dir (the msb exec.log test). */
const realHome = process.env.HOME
afterEach(() => {
  process.env.HOME = realHome
})

type CapturedInvocation = {
  argv: string[]
  cwd: string
  env: Record<string, string>
}

describe("createOpencodeRunner", () => {
  test("R1: runs the command in the workspace dir, prompt as one arg, and returns captured stdout", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "samskara-runner-test-"))
    // A fake opencode: prints the cwd, the model flag position ($3) and the prompt ($4),
    // wrapped like a real harness answer (prose + fenced block last).
    const script = join(workspaceDir, "fake-opencode.sh")
    writeFileSync(
      script,
      [
        "#!/usr/bin/env bash",
        'echo "cwd: $(pwd)"',
        'echo "model: $3"',
        'echo "prompt: $4"',
        // Single-quoted: backticks inside double quotes would be command substitution.
        "echo '```json'",
        "echo '{\"ok\": true}'",
        "echo '```'",
      ].join("\n"),
    )
    chmodSync(script, 0o755)

    const runner = createOpencodeRunner({
      model: "fake-model",
      timeoutMs: 10_000,
      log: log(),
      command: script,
    })
    const result = await runner.run({ prompt: "review this session", workspaceDir })

    expect(result.exitCode).toBe(0)
    // bash's pwd resolves the macOS /var symlink, so compare against the real path.
    expect(result.stdout).toContain(`cwd: ${require("node:fs").realpathSync(workspaceDir)}`)
    expect(result.stdout).toContain("model: fake-model")
    expect(result.stdout).toContain("prompt: review this session")
    expect(result.stdout).toContain('{"ok": true}')
  })

  test("R2: the soft runner reports a capped stdout tail as agentLog", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "samskara-runner-test-"))
    const script = join(workspaceDir, "chatty-opencode.sh")
    // 30k chars of chatter: far beyond the 24 KiB agentLog cap.
    writeFileSync(
      script,
      ["#!/usr/bin/env bash", `printf '%.0sX' {1..30000}`, `printf '\\nTHE-END\\n'`].join("\n"),
    )
    chmodSync(script, 0o755)

    const runner = createOpencodeRunner({
      model: "fake-model",
      timeoutMs: 10_000,
      log: log(),
      command: script,
    })
    const result = await runner.run({ prompt: "p", workspaceDir })

    expect(result.agentLog).toBeDefined()
    expect((result.agentLog ?? "").length).toBeLessThanOrEqual(MAX_AGENT_LOG_CHARS)
    // It is the TAIL: the most recent output survives, the ancient prefix does not.
    expect(result.agentLog).toContain("THE-END")
    expect(result.agentLog).not.toContain("cwd")
  })
})

describe("createClaudeRunner", () => {
  test("R3: runs claude -p with the prompt and model in the workspace, HOME and CLAUDE_CONFIG_DIR redirected into it", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "samskara-claude-test-"))
    const capturePath = join(workspaceDir, "captured.json")
    const script = join(workspaceDir, "fake-claude.sh")
    writeFileSync(
      script,
      [
        "#!/usr/bin/env bash",
        `node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({argv: process.argv.slice(2), cwd: process.cwd(), HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR}, null, 2))' "${capturePath}" "$@"`,
        "exit 0",
      ].join("\n"),
    )
    chmodSync(script, 0o755)

    const runner = createClaudeRunner({
      model: "sonnet",
      timeoutMs: 30_000,
      log: log(),
      command: script,
    })
    const result = await runner.run({ prompt: "review this session", workspaceDir })

    expect(result.exitCode).toBe(0)
    const captured = JSON.parse(readFileSync(capturePath, "utf8")) as {
      argv: string[]
      cwd: string
      HOME: string
      CLAUDE_CONFIG_DIR: string
    }
    expect(captured.argv).toEqual([
      "-p",
      "review this session",
      "--model",
      "sonnet",
      "--output-format",
      "text",
      "--dangerously-skip-permissions",
    ])
    expect(captured.cwd).toBe(realpathSync(workspaceDir))
    // The reviewer gets an empty Claude home inside the workspace: it cannot read the
    // user's real session history, mirroring the XDG redirect the opencode runner does.
    expect(captured.HOME).toBe(join(workspaceDir, "claude-home"))
    expect(captured.CLAUDE_CONFIG_DIR).toBe(join(workspaceDir, "claude-config"))
  })

  test("R4: a non-zero claude exit rejects as HarnessRunnerError carrying stderr", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "samskara-claude-test-"))
    const script = join(workspaceDir, "failing-claude.sh")
    writeFileSync(script, ["#!/usr/bin/env bash", "echo 'no credentials' >&2", "exit 1"].join("\n"))
    chmodSync(script, 0o755)

    const runner = createClaudeRunner({
      model: "sonnet",
      timeoutMs: 10_000,
      log: log(),
      command: script,
    })
    await expect(runner.run({ prompt: "p", workspaceDir })).rejects.toMatchObject({
      name: "HarnessRunnerError",
      stderr: expect.stringContaining("no credentials"),
    })
  })
})

/**
 * Tests for the msb-wrapped runner. The VM itself cannot run inside CI cheaply, so we
 * stub `msb` with a tiny node script that captures argv/env to a JSON file the assertions
 * read back — same shape as R1's fake-opencode.sh, just richer.
 */
const writeFakeMsb = (workspaceDir: string, capturePath: string): string => {
  const script = join(workspaceDir, "fake-msb.sh")
  // The script is tackled onto sh's PATH via `msbBin`, so anything it writes becomes the
  // captured invocation. Use node to keep escaping honest. `"$@"` forwards the argv msb
  // was asked to run with so the inline node sees them as `process.argv[2..]`.
  writeFileSync(
    script,
    [
      "#!/usr/bin/env bash",
      `node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({argv: process.argv.slice(2), cwd: process.cwd(), env: process.env}, null, 2))' "${capturePath}" "$@"`,
      // The harness expects `opencode run` inside the VM to print a review on stdout. The
      // fake shim is what the parent sees, so it must emit *some* stdout — the pipeline's
      // contract is "exit 0 with content", not "valid XML". Schema validation lives one
      // layer up.
      `echo '{"fake": true}'`,
      "exit 0",
    ].join("\n"),
  )
  chmodSync(script, 0o755)
  return script
}

describe("createMsbWrappedRunner", () => {
  test("MR1: wraps opencode in `msb run`, mounts the workspace, sets XDG inside the VM", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "samskara-msb-test-"))
    const capturePath = join(workspaceDir, "captured.json")
    const fakeMsb = writeFakeMsb(workspaceDir, capturePath)

    const runner = createMsbWrappedRunner({
      model: "zai-coding-plan/glm-5.3",
      timeoutMs: 30_000,
      log: log(),
      msbBin: fakeMsb,
      image: "node:22-slim",
      memoryMb: 2048,
    })

    await runner.run({ prompt: "review this session", workspaceDir })

    const captured = JSON.parse(readFileSync(capturePath, "utf8")) as CapturedInvocation
    // The msb subcommand is `run`; everything after it is a flag or argument. We search
    // the whole argv for the workspace mount rather than asserting a fixed position —
    // msb's flag order is stable but we want the assertion to survive re-ordering.
    const flags = captured.argv
    expect(flags).toContain("run")
    expect(flags).toContain("--no-tty")
    // The msb --timeout value is strictly less than the harness's, with margin. msb only
    // accepts duration suffixes (Xs/Xm/Xh) — a raw millisecond count is rejected as
    // "invalid digit found in string" — so the runner rounds up to whole seconds.
    const timeoutIdx = flags.indexOf("--timeout")
    expect(timeoutIdx).toBeGreaterThan(-1)
    const timeoutValue = flags[timeoutIdx + 1]
    expect(timeoutValue).toMatch(/^\d+s$/)
    const timeoutSec = Number.parseInt(timeoutValue ?? "0", 10)
    expect(timeoutSec).toBeLessThan(30)
    expect(60 - timeoutSec).toBeGreaterThanOrEqual(5) // for MR2 below
    expect(flags).toContain("--name")
    expect(flags.some((flag) => flag.startsWith("samskara-ai-review-"))).toBe(true)
    // Workspace is bind-mounted at /work; XDG paths inside the VM point into it so the
    // reviewer's opencode state cannot read the user's host db. The fake-msb shim does not
    // actually run a guest, so we assert the `-e KEY=VALUE` flags msb would forward — those
    // are the contract for the real VM.
    expect(flags).toContain(`${workspaceDir}:/work`)
    expect(flags).toContain("-e")
    expect(flags).toContain("XDG_DATA_HOME=/work/xdg-data")
    expect(flags).toContain("XDG_CONFIG_HOME=/work/xdg-config")
    expect(flags).toContain("XDG_CACHE_HOME=/work/xdg-cache")
    // Image is the positional just before `--`; the inner command bootstraps opencode via
    // npm (the snapshot path would skip this) and runs `opencode run` with the prompt
    // quoted as the shell's last arg.
    const dashIdx = flags.indexOf("--")
    expect(dashIdx).toBeGreaterThan(-1)
    expect(flags[dashIdx - 1]).toBe("node:22-slim")
    const inner = flags.slice(dashIdx + 1)
    expect(inner[0]).toBe("sh")
    expect(inner).toContain("-lc")
    const bootstrap = inner[inner.indexOf("-lc") + 1] ?? ""
    expect(bootstrap).toContain("npm i -g opencode-ai@")
    expect(bootstrap).toContain("opencode run --model zai-coding-plan/glm-5.3")
    expect(bootstrap).toContain("'review this session'")
    // The host workspace path must not leak into the guest's command line.
    expect(inner.join(" ")).not.toContain(workspaceDir)
  })

  test("MR2: buildMsbArgs caps the msb --timeout with a fixed safety margin", () => {
    const args = buildMsbArgs({
      model: "x",
      timeoutMs: 60_000,
      image: "node:22-slim",
      msbSnapshot: undefined,
      memoryMb: 2048,
      sandboxName: "samskara-ai-review-test",
      workspaceDir: "/tmp/ws",
      prompt: "p",
    })
    const timeoutIdx = args.indexOf("--timeout")
    const valueRaw = args[timeoutIdx + 1] ?? "0s"
    expect(valueRaw).toMatch(/^\d+s$/)
    const value = Number.parseInt(valueRaw, 10)
    // Parent timeout is 60s; msb's is at least 5s less, in seconds.
    expect(60 - value).toBeGreaterThanOrEqual(5)
    expect(value).toBeLessThan(60)
  })

  test("MR3: when `msbSnapshot` is set, --snapshot replaces the image positional", () => {
    const args = buildMsbArgs({
      model: "x",
      timeoutMs: 30_000,
      image: "node:22-slim",
      msbSnapshot: "opencode-with-cli",
      memoryMb: 2048,
      sandboxName: "samskara-ai-review-test",
      workspaceDir: "/tmp/ws",
      prompt: "p",
    })
    expect(args).toContain("--snapshot")
    expect(args).toContain("opencode-with-cli")
    // Image positional is absent when a snapshot is in use.
    expect(args).not.toContain("node:22-slim")
  })

  test("MR4: the workspace's xdg-data is the in-guest XDG_DATA_HOME — no host paths leak", () => {
    const args = buildMsbArgs({
      model: "x",
      timeoutMs: 30_000,
      image: "node:22-slim",
      msbSnapshot: undefined,
      memoryMb: 2048,
      sandboxName: "samskara-ai-review-test",
      workspaceDir: "/tmp/ws",
      prompt: "p",
    })
    // The volume flag for the workspace is the only /tmp path that ever appears in argv;
    // the guest's XDG_DATA_HOME is derived from the mount, not from the host's HOME.
    expect(args).toContain("/tmp/ws:/work")
    const homeLeak = args.find((flag) => flag.includes(".local/share/opencode"))
    expect(homeLeak).toBeUndefined()
  })

  test("MR5: the inner command closes stdin to /dev/null — opencode blocks on an open stdin pipe", () => {
    // Without the trailing `</dev/null` the guest hangs to the msb timeout producing no
    // output (proven live). This is the load-bearing assertion that keeps that fix in place.
    const argsNoSnapshot = buildMsbArgs({
      model: "x",
      timeoutMs: 30_000,
      image: "node:22-slim",
      msbSnapshot: undefined,
      memoryMb: 2048,
      sandboxName: "samskara-ai-review-test",
      workspaceDir: "/tmp/ws",
      prompt: "p",
    })
    const dashIdx = argsNoSnapshot.indexOf("--")
    const inner = argsNoSnapshot.slice(dashIdx + 1)
    const bootstrap = inner[inner.indexOf("-lc") + 1] ?? ""
    expect(bootstrap.trimEnd().endsWith("</dev/null")).toBe(true)

    const argsSnapshot = buildMsbArgs({
      model: "x",
      timeoutMs: 30_000,
      image: "node:22-slim",
      msbSnapshot: "opencode-with-cli",
      memoryMb: 2048,
      sandboxName: "samskara-ai-review-test",
      workspaceDir: "/tmp/ws",
      prompt: "p",
    })
    // Snapshot variant: the bootstrap shell is gone, so </dev/null> is a direct argv
    // entry alongside the prompt. msb can swallow argv-quoted redirects when they appear
    // in the middle of an argv, so the trailing-element assertion is the load-bearing one.
    expect(argsSnapshot.at(-1)).toBe("</dev/null>")
    const joined = argsSnapshot.join(" ")
    expect(joined).toMatch(/<\/dev\/null/)
  })

  test("MR6: a successful run reads the agent's command lines back from the sandbox exec.log", async () => {
    // The msb sandbox dir lives under $HOME/.microsandbox/sandboxes/<name> on the host
    // (the same path scripts/ai-review-watch.sh tails). Repoint HOME at a scratch dir so
    // the fake msb below can fabricate the exec.log exactly where the runner looks.
    const scratchHome = mkdtempSync(join(tmpdir(), "samskara-msb-home-"))
    process.env.HOME = scratchHome
    const workspaceDir = mkdtempSync(join(tmpdir(), "samskara-msb-test-"))
    const capturePath = join(workspaceDir, "captured.json")

    // Fake msb: capture argv like writeFakeMsb, and — the new part — drop a sandbox
    // logs/exec.log under $HOME for the --name it was handed, holding the guest's stream
    // records ($-prefixed bash prompts plus noise), as a real run would. Written via node
    // so JSON escaping stays honest (JSON.stringify escapes ESC as \u001b, exactly the
    // byte sequence scripts/ai-review-watch.sh --peek greps for).
    const script = join(workspaceDir, "fake-msb.sh")
    writeFileSync(
      script,
      [
        "#!/usr/bin/env bash",
        `node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({argv: process.argv.slice(2)}, null, 2))' "${capturePath}" "$@"`,
        'NAME=""; while [[ $# -gt 0 ]]; do if [[ "$1" == "--name" ]]; then NAME="$2"; fi; shift; done',
        'LOGDIR="$HOME/.microsandbox/sandboxes/$NAME/logs"',
        'mkdir -p "$LOGDIR"',
        'LOGDIR="$LOGDIR" node -e \'const fs=require("fs");const recs=[{t:1755700000,s:"stdout",d:"booting"},{t:1755700001,s:"stderr",d:"\\u001b[0m$ cat session.json | head -5"},{t:1755700002,s:"stderr",d:"\\u001b[0m$ python3 -c \\"import xml\\""}];fs.writeFileSync(process.env.LOGDIR+"/exec.log",recs.map(r=>JSON.stringify(r)).join("\\n")+"\\n")\'',
        `echo '{"fake": true}'`,
        "exit 0",
      ].join("\n"),
    )
    chmodSync(script, 0o755)

    const runner = createMsbWrappedRunner({
      model: "m",
      timeoutMs: 30_000,
      log: log(),
      msbBin: script,
    })
    const result = await runner.run({ prompt: "p", workspaceDir })

    // The captured argv names the sandbox; the exec.log the runner read back is that one.
    const captured = JSON.parse(readFileSync(capturePath, "utf8")) as { argv: string[] }
    const nameIdx = captured.argv.indexOf("--name")
    const sandboxName = captured.argv[nameIdx + 1] ?? ""
    expect(result.logPath).toBe(
      join(scratchHome, ".microsandbox", "sandboxes", sandboxName, "logs", "exec.log"),
    )
    expect(result.agentLog).toContain("cat session.json | head -5")
    expect(result.agentLog).toContain("import xml")
    expect(result.agentLog).not.toContain("booting")
  })

  test("MR7: when no sandbox exec.log exists, the msb runner falls back to a stdout tail", async () => {
    // HOME points at a pristine scratch dir (no .microsandbox tree), so the exec.log read
    // fails and the agentLog degrades to the harness stdout tail instead of erroring.
    const scratchHome = mkdtempSync(join(tmpdir(), "samskara-msb-home-empty-"))
    process.env.HOME = scratchHome
    const workspaceDir = mkdtempSync(join(tmpdir(), "samskara-msb-test-"))
    const script = join(workspaceDir, "fake-msb.sh")
    writeFileSync(
      script,
      ["#!/usr/bin/env bash", `echo 'harness stdout says hi'`, "exit 0"].join("\n"),
    )
    chmodSync(script, 0o755)

    const runner = createMsbWrappedRunner({
      model: "m",
      timeoutMs: 30_000,
      log: log(),
      msbBin: script,
    })
    const result = await runner.run({ prompt: "p", workspaceDir })

    expect(result.logPath).toBeUndefined()
    expect(result.agentLog).toContain("harness stdout says hi")
  })
})
