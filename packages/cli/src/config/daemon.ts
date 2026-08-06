import { spawn } from "node:child_process"
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import * as lockfile from "proper-lockfile"
import { sleep } from "../io.js"
import { configHome, watchPidPath, watcherCrashLogPath } from "./paths.js"

const START_LOCK_TIMEOUT_MS = 5_000
const START_LOCK_RETRY_MS = 20
const STOP_TIMEOUT_MS = 5_000

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const withStartLock = async <T>(action: () => T): Promise<T> => {
  mkdirSync(dirname(watchPidPath()), { recursive: true })
  const release = await lockfile.lock(watchPidPath(), {
    realpath: false,
    stale: 30_000,
    update: 10_000,
    retries: {
      retries: Math.ceil(START_LOCK_TIMEOUT_MS / START_LOCK_RETRY_MS),
      minTimeout: START_LOCK_RETRY_MS,
      maxTimeout: START_LOCK_RETRY_MS,
    },
  })
  try {
    return action()
  } finally {
    await release()
  }
}

const persistPid = (path: string, pid: number): void => {
  writeFileSync(path, String(pid), { mode: 0o600 })
  chmodSync(path, 0o600)
}

const removePidFile = (): void => {
  try {
    unlinkSync(watchPidPath())
  } catch {
    return
  }
}

const noteFallback = (message: string): void => {
  process.stderr.write(`${message}\n`)
}

export const resolveCliEntry = (onFallback: (message: string) => void = noteFallback): string => {
  const compiled = fileURLToPath(new URL("../index.js", import.meta.url))
  if (existsSync(compiled)) return compiled

  const source = fileURLToPath(new URL("../index.ts", import.meta.url))
  if (existsSync(source)) {
    onFallback?.(
      `No compiled CLI entry was found at ${compiled}, so the watcher will be started from the TypeScript source at ${source}.`,
    )
    return source
  }

  throw new Error(
    `Could not locate the Samskara CLI entry point. Looked for ${compiled} and ${source}. Run \`bun run --cwd packages/cli build\` to produce the compiled entry.`,
  )
}

export const watcherPid = (): number | null => {
  const path = watchPidPath()
  if (!existsSync(path)) return null
  let pid: number
  try {
    pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10)
  } catch {
    removePidFile()
    return null
  }
  if (!Number.isFinite(pid) || pid <= 0 || !isProcessAlive(pid)) {
    removePidFile()
    return null
  }
  return pid
}

const closeDescriptor = (descriptor: number | null): void => {
  if (descriptor === null) return
  try {
    closeSync(descriptor)
  } catch {
    return
  }
}

const spawnWatcher = (cliEntry: string) => {
  const crashLogPath = watcherCrashLogPath()
  mkdirSync(dirname(crashLogPath), { recursive: true })
  let stdoutFd: number | null = null
  let stderrFd: number | null = null
  try {
    stdoutFd = openSync(crashLogPath, "a")
    stderrFd = openSync(crashLogPath, "a")
    return spawn(process.execPath, [cliEntry, "watch", "--foreground"], {
      detached: true,
      stdio: ["ignore", stdoutFd, stderrFd],
      env: { ...process.env, SAMSKARA_HOME: configHome(), SAMSKARA_DAEMON: "1" },
    })
  } finally {
    closeDescriptor(stdoutFd)
    closeDescriptor(stderrFd)
  }
}

export const startWatcherDaemon = (cliEntry: string = resolveCliEntry()): Promise<number> =>
  withStartLock(() => {
    const existing = watcherPid()
    if (existing !== null) return existing

    const child = spawnWatcher(cliEntry)
    if (!child.pid) {
      child.kill("SIGTERM")
      throw new Error("failed to spawn watcher daemon")
    }
    try {
      persistPid(watchPidPath(), child.pid)
    } catch (error) {
      child.kill("SIGTERM")
      throw error
    }
    child.unref()
    return child.pid
  })

export const stopWatcherDaemon = async (): Promise<boolean> => {
  const pid = watcherPid()
  if (pid === null) return false
  try {
    process.kill(pid, "SIGTERM")
  } catch {
    removePidFile()
    return true
  }

  const deadline = Date.now() + STOP_TIMEOUT_MS
  while (isProcessAlive(pid) && Date.now() < deadline) await sleep(50)
  if (isProcessAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      removePidFile()
      return true
    }
  }
  removePidFile()
  return true
}

export const reviveWatcher = async (): Promise<number | null> => {
  const existing = watcherPid()
  if (existing !== null) return existing
  try {
    return await startWatcherDaemon()
  } catch {
    return null
  }
}
