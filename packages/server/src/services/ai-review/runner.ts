import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type pino from "pino"
import { agentLogFromExecLog, capAgentLog } from "./agentlog.js"

/**
 * The seam between the server and a coding harness: run one prompt inside a workspace
 * directory and hand back what the harness printed. Anything more (streaming, tool events)
 * stays behind this interface until a consumer needs it.
 */
export type HarnessRunnerResult = {
  readonly stdout: string
  readonly exitCode: number
  /**
   * Time from `spawn` to the first byte of harness stdout reaching us, or `null` if the
   * harness exited before producing any output. A watching human can tell a stuck run
   * (`firstByteMs` climbing past 60s with no byte) from a healthy one (5–15s to first
   * byte, then steady steps) without reading the log.
   */
  readonly firstByteMs: number | null
  /**
   * Best-effort capture of the agent's own command lines for the persisted run log:
   * the parsed sandbox `exec.log` when the runner can reach it, else a capped tail of
   * harness stdout. Always capped at `MAX_AGENT_LOG_CHARS`.
   */
  readonly agentLog?: string
  /** Where `agentLog` came from (the sandbox exec.log path), when a file was read. */
  readonly logPath?: string
}

export type HarnessRunner = {
  run(input: HarnessRunInput): Promise<HarnessRunnerResult>
}

/** Which CLI runs the reviewer for one call — per-run choice, env-driven when absent. */
export type ReviewHarness = "opencode" | "claude"

export type HarnessRunInput = {
  readonly prompt: string
  readonly workspaceDir: string
  /** Per-run harness; a concrete runner ignores values that are not its own. */
  readonly harness?: ReviewHarness
  /** Per-run model override; each runner falls back to its constructed default. */
  readonly model?: string
}

/** Collected stdout is capped so a runaway harness cannot balloon the process. */
const MAX_STDOUT_BYTES = 2 * 1024 * 1024

/** SIGTERM grace before the escalation to SIGKILL. */
const KILL_GRACE_MS = 5_000

export class HarnessRunnerError extends Error {
  readonly stderr: string | undefined
  readonly timedOut: boolean

  constructor(message: string, options: { stderr?: string; timedOut?: boolean } = {}) {
    super(message)
    this.name = "HarnessRunnerError"
    this.stderr = options.stderr
    this.timedOut = options.timedOut ?? false
  }
}

/**
 * The reviewer must not see the user's real opencode state: its session database holds the
 * very sessions under review, and a reviewer that can look itself up cites foreign message
 * ids instead of the export's. Redirecting XDG data/config/cache into the workspace gives
 * the reviewer an empty opencode home. The pipeline is the single place that stages
 * `auth.json` into the workspace — both this soft runner and the msb-wrapped one read the
 * same workspace, so a single copy there covers both.
 */
const sandboxEnv = (workspaceDir: string): NodeJS.ProcessEnv => ({
  ...process.env,
  XDG_DATA_HOME: join(workspaceDir, "xdg-data"),
  XDG_CONFIG_HOME: join(workspaceDir, "xdg-config"),
  XDG_CACHE_HOME: join(workspaceDir, "xdg-cache"),
})

/**
 * Claude Code keeps its config and credentials under CLAUDE_CONFIG_DIR (default ~/.claude)
 * and its state under HOME. Redirecting both into the workspace gives the reviewer an empty
 * Claude home — the same isolation the XDG redirect gives opencode: it cannot read the
 * user's real session history, which is exactly the foreign-data temptation the export's
 * alias ids exist to prevent.
 */
const claudeSandboxEnv = (workspaceDir: string): NodeJS.ProcessEnv => ({
  ...process.env,
  CLAUDE_CONFIG_DIR: join(workspaceDir, "claude-config"),
  HOME: join(workspaceDir, "claude-home"),
})

type SpawnCollectResult = { readonly stdout: string; readonly firstByteMs: number | null }

/**
 * One harness CLI run: spawn with captured (and capped) stdout/stderr, first-byte timing,
 * and the timeout → SIGTERM → SIGKILL escalation. Shared by every soft (in-process) runner
 * so opencode and claude behave identically on every failure axis; the msb runner keeps its
 * own close path because a successful close reads the sandbox exec.log before resolving.
 */
const spawnCollect = (opts: {
  readonly command: string
  readonly args: string[]
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly timeoutMs: number
  readonly log: pino.Logger
}): Promise<SpawnCollectResult> =>
  new Promise((resolve, reject) => {
    const spawnStartedAt = Date.now()
    const child = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stdout = ""
    let stdoutBytes = 0
    let stderr = ""
    let stderrBytes = 0
    let firstByteMs: number | null = null
    let settled = false

    const collect =
      (kind: "stdout" | "stderr") =>
      (chunk: Buffer): void => {
        if (firstByteMs === null) firstByteMs = Date.now() - spawnStartedAt
        const bytes = chunk.byteLength
        if (kind === "stdout") {
          if (stdoutBytes < MAX_STDOUT_BYTES) {
            stdout += chunk.toString("utf8").slice(0, MAX_STDOUT_BYTES - stdoutBytes)
          }
          stdoutBytes += bytes
          return
        }
        if (stderrBytes < MAX_STDOUT_BYTES) {
          stderr += chunk.toString("utf8").slice(0, MAX_STDOUT_BYTES - stderrBytes)
        }
        stderrBytes += bytes
      }
    child.stdout.on("data", collect("stdout"))
    child.stderr.on("data", collect("stderr"))

    let killTimer: ReturnType<typeof setTimeout> | undefined
    const timeoutTimer = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) return
      opts.log.warn({ command: opts.command, timeoutMs: opts.timeoutMs }, "harness run timed out")
      child.kill("SIGTERM")
      killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS)
    }, opts.timeoutMs)

    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutTimer)
      if (killTimer !== undefined) clearTimeout(killTimer)
      fn()
    }

    child.on("error", (err) =>
      finish(() =>
        reject(new HarnessRunnerError(`failed to start "${opts.command}": ${err.message}`)),
      ),
    )

    child.on("close", (code, signal) => {
      finish(() => {
        if (signal === "SIGTERM" || signal === "SIGKILL") {
          reject(
            new HarnessRunnerError(`harness run timed out after ${opts.timeoutMs}ms`, {
              stderr,
              timedOut: true,
            }),
          )
          return
        }
        if (code !== 0) {
          reject(
            new HarnessRunnerError(`harness run exited with code ${code ?? "null"}`, { stderr }),
          )
          return
        }
        resolve({ stdout, firstByteMs })
      })
    })
  })

/**
 * Runs the prompt through the local `opencode` CLI (`opencode run --model <model> "<prompt>"`)
 * with the workspace as cwd. Nothing is inherited — stdout/stderr are captured by reading the
 * streams incrementally, so output far beyond what anyone would collect is still safe. A
 * non-zero exit or a timeout rejects; the caller decides what that means for the review.
 */
export const createOpencodeRunner = (opts: {
  model: string
  /** Env-driven (AI_REVIEW_TIMEOUT_MS); passed in so tests never depend on process.env. */
  timeoutMs: number
  log: pino.Logger
  /** Overridable command path; tests point this at a fake script instead of real opencode. */
  command?: string
}): HarnessRunner => ({
  run: ({ prompt, workspaceDir, model }) =>
    spawnCollect({
      command: opts.command ?? "opencode",
      args: ["run", "--model", model ?? opts.model, prompt],
      cwd: workspaceDir,
      env: sandboxEnv(workspaceDir),
      timeoutMs: opts.timeoutMs,
      log: opts.log,
    }).then(({ stdout, firstByteMs }) => ({
      stdout,
      exitCode: 0,
      firstByteMs,
      agentLog: capAgentLog(stdout),
    })),
})

/**
 * The claude lane of AI_REVIEW_HARNESS: runs the prompt through the local Claude Code CLI in
 * headless print mode (`claude -p "<prompt>" --model <model>`) inside the workspace. The
 * permission skip is required for headless autonomy — the reviewer's whole job is to read
 * session.json and write review.xml in its cwd, and a headless claude prompted for tool
 * permission would stall to the timeout instead of asking. Soft-sandbox only for now: the
 * msb hard sandbox bootstraps `opencode-ai` specifically, so a claude-in-microVM image is a
 * separate piece of work.
 */
export const createClaudeRunner = (opts: {
  model: string
  /** Env-driven (AI_REVIEW_TIMEOUT_MS); passed in so tests never depend on process.env. */
  timeoutMs: number
  log: pino.Logger
  /** Overridable command path; tests point this at a fake script instead of real claude. */
  command?: string
}): HarnessRunner => ({
  run: ({ prompt, workspaceDir, model }) =>
    spawnCollect({
      command: opts.command ?? "claude",
      args: [
        "-p",
        prompt,
        "--model",
        model ?? opts.model,
        "--output-format",
        "text",
        "--dangerously-skip-permissions",
      ],
      cwd: workspaceDir,
      env: claudeSandboxEnv(workspaceDir),
      timeoutMs: opts.timeoutMs,
      log: opts.log,
    }).then(({ stdout, firstByteMs }) => ({
      stdout,
      exitCode: 0,
      firstByteMs,
      agentLog: capAgentLog(stdout),
    })),
})

// ─── msb-wrapped runner ─────────────────────────────────────────────────────
//
// Above the soft XDG-redirect sits a real microVM (libkrun via msb). The guest has no view of
// the host filesystem beyond the bind mounts we hand it, so the reviewer cannot read /tmp/
// opencode/ or any path outside the workspace. Default image is `node:22-slim` with `opencode-
// ai` npm-installed at startup; pass `msbSnapshot` to skip the install.

const MSB_TIMEOUT_MARGIN_MS = 5_000
const MSB_DEFAULT_IMAGE = "node:22-slim"
const MSB_DEFAULT_MEMORY_MB = 2_048
const MSB_SANDBOX_PREFIX = "samskara-ai-review-"

export type MsbRunnerOpts = {
  readonly model: string
  readonly timeoutMs: number
  readonly log: pino.Logger
  /** Overridable msb binary path; tests point this at a fake script instead of real msb. */
  readonly msbBin?: string
  /** Base image used when `msbSnapshot` is unset. Default `node:22-slim`. */
  readonly image?: string
  /** Snapshot name to boot from; when present, replaces the image positional. */
  readonly msbSnapshot?: string
  /** VM memory in MiB. Default 2048 — opencode + node comfortably fit. */
  readonly memoryMb?: number
}

export type BuildMsbArgsInput = {
  readonly model: string
  readonly timeoutMs: number
  readonly image: string
  readonly msbSnapshot: string | undefined
  readonly memoryMb: number
  readonly sandboxName: string
  readonly workspaceDir: string
  readonly prompt: string
}

/**
 * The argv handed to `msb`. `msb` is argv[0] when spawned; this returns the args that follow.
 * The inner command (after `--`) is `opencode run --model <model> <prompt>` — the runner is
 * the single point that decides how the guest invokes opencode, so the prompt contract is
 * identical to the soft-sandbox runner.
 */
export const buildMsbArgs = (input: BuildMsbArgsInput): string[] => {
  // msb's --timeout must be strictly shorter than the harness's parent timeout, otherwise
  // both fire at once and the runner cannot tell which one killed the inner command. 5s is
  // enough for the parent to react and surface a harnessFailed. msb's parser only accepts
  // duration suffixes (Xs/Xm/Xh) — a raw millisecond count like "55000ms" errors out as
  // "invalid digit found in string" — so we round up to whole seconds.
  const msbTimeoutMs = Math.max(1_000, input.timeoutMs - MSB_TIMEOUT_MARGIN_MS)
  const msbTimeoutSec = Math.max(1, Math.ceil(msbTimeoutMs / 1000))
  const args: string[] = [
    "run",
    "--no-tty",
    "--timeout",
    `${msbTimeoutSec}s`,
    "--name",
    input.sandboxName,
    "-m",
    `${input.memoryMb}M`,
    "-v",
    `${input.workspaceDir}:/work`,
    "-w",
    "/work",
  ]
  if (input.msbSnapshot !== undefined) {
    args.push("--snapshot", input.msbSnapshot)
  }
  // XDG paths point inside /work — the guest's opencode writes its db / log / config to the
  // mount, never to the host's XDG home. The pipeline is responsible for staging auth.json
  // inside xdg-data/opencode/ before this runner is called.
  args.push(
    "-e",
    "XDG_DATA_HOME=/work/xdg-data",
    "-e",
    "XDG_CONFIG_HOME=/work/xdg-config",
    "-e",
    "XDG_CACHE_HOME=/work/xdg-cache",
    "-e",
    "HOME=/root",
  )
  // The image is the positional right before `--` UNLESS a snapshot is in use (msb docs).
  if (input.msbSnapshot === undefined) args.push(input.image)
  // No snapshot means the guest does not yet have opencode installed; bootstrap it via npm.
  // A snapshot built from this image (see `scripts/build-review-snapshot.sh`) skips the install.
  // The trailing `</dev/null` is load-bearing: msb does not propagate the host process's
  // DEVNULL stdin into the guest, and opencode (like most agent CLIs) blocks on a read of
  // stdin. Without the in-guest redirect the guest hangs to the msb timeout, produces no
  // output, and the runner's `first_byte` signal never fires. This matches the internal kit
  // harness, which carries the same pattern.
  if (input.msbSnapshot === undefined) {
    args.push(
      "--",
      "sh",
      "-lc",
      `npm i -g opencode-ai@${OPENCODE_VERSION} >/dev/null 2>&1 && exec opencode run --model ${input.model} ${shellQuote(input.prompt)} </dev/null`,
    )
  } else {
    args.push("--", "opencode", "run", "--model", input.model, input.prompt, "</dev/null>")
  }
  return args
}

/**
 * The npm `opencode-ai` version the bootstrap installs into a fresh VM. Pinned to the
 * version the user runs on the host so the in-guest behavior matches what they observe
 * locally; bump together with `bun add -g opencode-ai`.
 */
const OPENCODE_VERSION = "1.18.23"

/** POSIX shell single-quote escape: end the run, insert ', reopen with '. */
const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`

/** Where msb writes a sandbox's stream log on the host — the path the watcher tails. */
export const msbExecLogPath = (sandboxName: string): string =>
  join(homedir(), ".microsandbox", "sandboxes", sandboxName, "logs", "exec.log")

/**
 * Spawns `msb run` with the workspace mounted and XDG redirected into it. The captured
 * stdout/stderr honors the same caps as the in-process runner, so a runaway VM cannot
 * balloon the server. Errors are surfaced as `HarnessRunnerError` so the pipeline's existing
 * failure handling stays unchanged.
 */
export const createMsbWrappedRunner = (opts: MsbRunnerOpts): HarnessRunner => ({
  run: ({ prompt, workspaceDir, model }) =>
    new Promise((resolve, reject) => {
      const sandboxName = `${MSB_SANDBOX_PREFIX}${randomBytes(6).toString("hex")}`
      const args = buildMsbArgs({
        model: model ?? opts.model,
        timeoutMs: opts.timeoutMs,
        image: opts.image ?? MSB_DEFAULT_IMAGE,
        msbSnapshot: opts.msbSnapshot,
        memoryMb: opts.memoryMb ?? MSB_DEFAULT_MEMORY_MB,
        sandboxName,
        workspaceDir,
        prompt,
      })
      const command = opts.msbBin ?? "msb"
      const spawnStartedAt = Date.now()
      const child = spawn(command, args, {
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      })

      let stdout = ""
      let stdoutBytes = 0
      let stderr = ""
      let stderrBytes = 0
      let firstByteMs: number | null = null
      let settled = false

      const collect =
        (kind: "stdout" | "stderr") =>
        (chunk: Buffer): void => {
          if (firstByteMs === null) firstByteMs = Date.now() - spawnStartedAt
          const bytes = chunk.byteLength
          if (kind === "stdout") {
            if (stdoutBytes < MAX_STDOUT_BYTES) {
              stdout += chunk.toString("utf8").slice(0, MAX_STDOUT_BYTES - stdoutBytes)
            }
            stdoutBytes += bytes
            return
          }
          if (stderrBytes < MAX_STDOUT_BYTES) {
            stderr += chunk.toString("utf8").slice(0, MAX_STDOUT_BYTES - stderrBytes)
          }
          stderrBytes += bytes
        }
      child.stdout.on("data", collect("stdout"))
      child.stderr.on("data", collect("stderr"))

      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        fn()
      }

      child.on("error", (err) =>
        finish(() =>
          reject(new HarnessRunnerError(`failed to start "${command}": ${err.message}`)),
        ),
      )

      child.on("close", (code, signal) => {
        finish(() => {
          if (signal === "SIGTERM" || signal === "SIGKILL") {
            reject(
              new HarnessRunnerError(`msb run timed out after ${opts.timeoutMs}ms`, {
                stderr,
                timedOut: true,
              }),
            )
            return
          }
          if (code !== 0) {
            reject(new HarnessRunnerError(`msb run exited with code ${code ?? "null"}`, { stderr }))
            return
          }
          // The sandbox's exec.log outlives the run on the host — the same file
          // scripts/ai-review-watch.sh --peek reads — so the agent's command lines are
          // captured after close. Best-effort: a missing or unreadable log degrades to a
          // stdout tail rather than failing a successful review.
          const logPath = msbExecLogPath(sandboxName)
          readFile(logPath, "utf8")
            .then((contents) => {
              const agentLog = agentLogFromExecLog(contents)
              if (agentLog === "") {
                resolve({ stdout, exitCode: 0, firstByteMs, agentLog: capAgentLog(stdout) })
                return
              }
              resolve({ stdout, exitCode: 0, firstByteMs, agentLog, logPath })
            })
            .catch(() => {
              resolve({ stdout, exitCode: 0, firstByteMs, agentLog: capAgentLog(stdout) })
            })
        })
      })
    }),
})
