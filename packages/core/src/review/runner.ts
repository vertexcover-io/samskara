import { type ChildProcess, spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type pino from "pino"
import { agentLogFromExecLog, capAgentLog } from "./agentlog.js"
import { CREDENTIAL_ENV, type ReviewHarness } from "./harness.js"

export type HarnessRunnerResult = {
  readonly stdout: string
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

/**
 * Children are detached so a timeout can signal their whole tree, which also means they do
 * not get the server's own signals -- so a restart would leave them running with nobody to
 * time them out, and their workspaces in /tmp forever.
 */
const liveChildren = new Set<ChildProcess>()

/** Killing a child rejects its runner promise, which is what removes the workspace. */
export const terminateHarnessChildren = (): number => {
  const count = liveChildren.size
  for (const child of liveChildren) {
    const { pid } = child
    if (pid === undefined) continue
    try {
      process.kill(-pid, "SIGTERM")
    } catch {
      child.kill("SIGTERM")
    }
  }
  return count
}

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
 * An empty opencode home. The real one holds the sessions under review, and a reviewer that
 * can look itself up cites message ids the export never gave it.
 */
export const HARNESS_STATE_DIR: Readonly<Record<ReviewHarness, string>> = {
  opencode: "xdg-data",
  claude: "claude-config",
}

const sandboxEnv = (workspaceDir: string): NodeJS.ProcessEnv => ({
  ...process.env,
  XDG_DATA_HOME: join(workspaceDir, HARNESS_STATE_DIR.opencode),
  XDG_CONFIG_HOME: join(workspaceDir, "xdg-config"),
  XDG_CACHE_HOME: join(workspaceDir, "xdg-cache"),
})

/** The same isolation for claude, which splits its state across HOME and CLAUDE_CONFIG_DIR. */
const claudeSandboxEnv = (workspaceDir: string): NodeJS.ProcessEnv => ({
  ...process.env,
  CLAUDE_CONFIG_DIR: join(workspaceDir, HARNESS_STATE_DIR.claude),
  HOME: join(workspaceDir, "claude-home"),
})

type SpawnCollectResult = { readonly stdout: string; readonly firstByteMs: number | null }

/**
 * Every runner spawns through here, so all three fail identically. An earlier msb-only copy
 * of this omitted the kill escalation and a wedged VM never settled its job.
 */
const spawnCollect = (opts: {
  readonly command: string
  readonly args: string[]
  /** Omitted for the msb runner, which sets the guest's cwd with `-w` instead. */
  readonly cwd?: string
  readonly env: NodeJS.ProcessEnv
  readonly timeoutMs: number
  readonly log: pino.Logger
  /** Names the run in error messages; defaults to the generic "harness run". */
  readonly label?: string
}): Promise<SpawnCollectResult> =>
  new Promise((resolve, reject) => {
    const spawnStartedAt = Date.now()
    const label = opts.label ?? "harness run"
    // `detached` puts the child in its own process group so the timeout can signal the
    // whole tree. Every harness here runs its real work in a grandchild -- `sh -lc` wraps
    // the guest command, msb spawns a VM supervisor -- and signalling only the direct
    // child leaves that grandchild alive holding the stdout pipe, so `close` never fires
    // and the run hangs past its own timeout. The child is deliberately not `unref`d: the
    // parent still waits on it.
    const child = spawn(opts.command, opts.args, {
      ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    })
    liveChildren.add(child)

    let stdout = ""
    let stdoutBytes = 0
    let stderr = ""
    let stderrBytes = 0
    let firstByteMs: number | null = null
    let settled = false

    const collect =
      (kind: "stdout" | "stderr") =>
      (chunk: Buffer): void => {
        // stdout only. A harness that prints a banner or a deprecation warning to stderr and
        // then wedges on an auth prompt would otherwise stamp this immediately, and the
        // watcher's "is it alive?" reading inverts: a dead run looks healthy for the whole
        // timeout window.
        if (kind === "stdout" && firstByteMs === null) firstByteMs = Date.now() - spawnStartedAt
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

    /**
     * Signals the child's whole process group, falling back to the child alone when the
     * group is already gone (ESRCH) -- a race with normal exit, not an error.
     */
    const signalTree = (signal: NodeJS.Signals): void => {
      const { pid } = child
      if (pid === undefined) return
      try {
        process.kill(-pid, signal)
      } catch {
        child.kill(signal)
      }
    }

    let killTimer: ReturnType<typeof setTimeout> | undefined
    const timeoutTimer = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) return
      opts.log.warn({ command: opts.command, timeoutMs: opts.timeoutMs }, `${label} timed out`)
      signalTree("SIGTERM")
      killTimer = setTimeout(() => signalTree("SIGKILL"), KILL_GRACE_MS)
    }, opts.timeoutMs)

    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      liveChildren.delete(child)
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
            new HarnessRunnerError(`${label} timed out after ${opts.timeoutMs}ms`, {
              stderr,
              timedOut: true,
            }),
          )
          return
        }
        if (code !== 0) {
          reject(new HarnessRunnerError(`${label} exited with code ${code ?? "null"}`, { stderr }))
          return
        }
        resolve({ stdout, firstByteMs })
      })
    })
  })

/** The local `opencode` CLI, workspace as cwd. A non-zero exit or a timeout rejects. */
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
      firstByteMs,
      agentLog: capAgentLog(stdout),
    })),
})

/**
 * ## Trust boundary, read before deploying this lane
 *
 * `--dangerously-skip-permissions` is required for headless autonomy — a claude prompted for
 * tool permission with no tty stalls to the timeout instead of asking — but it is the only
 * capability control there is. The `HOME`/`CLAUDE_CONFIG_DIR` redirect below is *data*
 * isolation, not capability isolation: cwd is not a jail, so Bash, Write and WebFetch reach
 * the whole host filesystem and network as the server user.
 *
 * What this reviewer reads is attacker-influenced. `buildSessionExport` copies user and
 * assistant message text into `session.json`, and the session title goes into the prompt;
 * both come straight from ingest, so anyone who can upload a session controls them. A session
 * whose text is shaped as an instruction is a prompt-injection vector into an agent with no
 * permission gate.
 *
 * Treat this lane as "runs untrusted input through an unsandboxed agent on the host": fine
 * single-tenant or local, not otherwise. The opencode lane's msb microVM is the hardened
 * path; a claude-in-microVM image is separate work, because the bootstrap installs opencode.
 */
export const createClaudeRunner = (opts: {
  model: string
  /** Env-driven (AI_REVIEW_TIMEOUT_MS); passed in so tests never depend on process.env. */
  timeoutMs: number
  log: pino.Logger
  /** Overridable command path; tests point this at a fake script instead of real claude. */
  command?: string
  /**
   * Default true. False hands the reviewer the server's own HOME, which is the only way it
   * can reach a macOS Keychain login — `claude setup-token` is the sandbox-safe alternative.
   * The cost is real: the reviewer can then read ~/.claude/projects, including the session
   * under review, so a citation may name a message the export never gave it. The grounding
   * gate still rejects those, but the run wastes a harness call to find out.
   */
  sandboxHome?: boolean
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
      env: opts.sandboxHome === false ? process.env : claudeSandboxEnv(workspaceDir),
      timeoutMs: opts.timeoutMs,
      log: opts.log,
    }).then(({ stdout, firstByteMs }) => ({
      stdout,
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
  /**
   * The guest's opencode credential. `msb` does not inherit the host environment, so the key
   * has to be handed over explicitly or the VM boots, installs opencode and fails auth.
   */
  readonly apiKey: string | undefined
}

/** The args after `msb` itself. The inner command matches the soft runner's, exactly. */
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
  // mount, never to the host's XDG home. It starts with no credential of its own, so the key
  // is passed in: `msb` hands the guest only what these `-e` flags name, and nothing stages a
  // credential file into the workspace.
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
  // Only this one variable crosses the boundary. The guest runs an agent over attacker-
  // influenced text, so handing it the server's whole environment would put JWT_SECRET,
  // DATABASE_URL and the GitHub client secret inside it.
  if (input.apiKey !== undefined && input.apiKey !== "") {
    args.push("-e", `OPENCODE_API_KEY=${input.apiKey}`)
  }
  // The image is the positional right before `--` UNLESS a snapshot is in use (msb docs).
  if (input.msbSnapshot === undefined) args.push(input.image)
  // Both branches run the inner command through `sh -lc`, and differ only in whether the
  // npm bootstrap precedes it: without a snapshot the guest has no opencode yet, and a
  // snapshot built from this image (see `scripts/build-review-snapshot.sh`) already does.
  //
  // The trailing `</dev/null` is load-bearing and is why a shell is required at all: msb
  // does not propagate the host process's DEVNULL stdin into the guest, and opencode (like
  // most agent CLIs) blocks on a read of stdin. Without the in-guest redirect the guest
  // hangs to the msb timeout, produces no output, and `first_byte` never fires. A previous
  // snapshot branch passed the redirect as a literal argv token with no shell to interpret
  // it, which silently appended a junk positional instead of closing stdin.
  //
  // Every interpolated value is shell-quoted: `model` reaches here straight from the
  // analyze request body, so an unquoted one would run as a command inside the guest — and
  // the guest has the workspace bind-mounted at /work.
  const bootstrap =
    input.msbSnapshot === undefined
      ? `npm i -g opencode-ai@${OPENCODE_VERSION} >/dev/null 2>&1 && `
      : ""
  args.push(
    "--",
    "sh",
    "-lc",
    `${bootstrap}exec opencode run --model ${shellQuote(input.model)} ${shellQuote(input.prompt)} </dev/null`,
  )
  return args
}

/** Pinned to the host's version so the guest behaves the way the operator sees locally. */
const OPENCODE_VERSION = "1.18.23"

/** POSIX shell single-quote escape: end the run, insert ', reopen with '. */
const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`

/** Where msb writes a sandbox's stream log on the host — the path the watcher tails. */
export const msbExecLogPath = (sandboxName: string): string =>
  join(homedir(), ".microsandbox", "sandboxes", sandboxName, "logs", "exec.log")

/** `msb run` with the workspace mounted, under the same caps and errors as the soft runners. */
export const createMsbWrappedRunner = (opts: MsbRunnerOpts): HarnessRunner => ({
  run: ({ prompt, workspaceDir, model }) => {
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
      apiKey: process.env[CREDENTIAL_ENV.opencode[0] as string],
    })
    return spawnCollect({
      command: opts.msbBin ?? "msb",
      args,
      env: { ...process.env },
      timeoutMs: opts.timeoutMs,
      log: opts.log,
      label: "msb run",
    }).then(({ stdout, firstByteMs }) => {
      // The sandbox's exec.log outlives the run on the host — the same file
      // scripts/ai-review-watch.sh --peek reads — so the agent's command lines are read
      // after close. Best-effort: a missing or unreadable log degrades to a stdout tail
      // rather than failing a review that otherwise succeeded.
      const logPath = msbExecLogPath(sandboxName)
      return readFile(logPath, "utf8")
        .then((contents) => {
          const agentLog = agentLogFromExecLog(contents)
          return agentLog === ""
            ? { stdout, firstByteMs, agentLog: capAgentLog(stdout) }
            : { stdout, firstByteMs, agentLog, logPath }
        })
        .catch(() => ({ stdout, firstByteMs, agentLog: capAgentLog(stdout) }))
    })
  },
})
