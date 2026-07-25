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
import { configHome, watchLogPath, watchPidPath } from "./paths.js"

const START_LOCK_TIMEOUT_MS = 5_000
const START_LOCK_RETRY_MS = 20

export type WatcherChild = {
  readonly pid?: number
  unref(): void
  kill(signal?: NodeJS.Signals): boolean
}

export type WatcherSpawnOptions = {
  readonly detached: true
  readonly stdio: readonly ["ignore", number, number]
  readonly env: NodeJS.ProcessEnv
}

export type SpawnWatcher = (
  command: string,
  args: ReadonlyArray<string>,
  options: WatcherSpawnOptions,
) => WatcherChild

export type ProcessProbe = (pid: number) => boolean
export type WatcherStartLock = (action: () => number) => number
export type PersistPid = (path: string, pid: number) => void

const defaultSpawn: SpawnWatcher = (command, args, options) =>
  spawn(command, [...args], {
    detached: options.detached,
    stdio: ["ignore", options.stdio[1], options.stdio[2]],
    env: options.env,
  })

const defaultProbe: ProcessProbe = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const defaultStartLock: WatcherStartLock = (action) => {
  mkdirSync(dirname(watchPidPath()), { recursive: true })
  const deadline = Date.now() + START_LOCK_TIMEOUT_MS
  let release: (() => void) | undefined
  while (!release) {
    try {
      release = lockfile.lockSync(watchPidPath(), {
        realpath: false,
        stale: 30_000,
        update: 10_000,
      })
    } catch (error) {
      if (Date.now() >= deadline) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, START_LOCK_RETRY_MS)
    }
  }
  try {
    return action()
  } finally {
    release()
  }
}

const defaultPersistPid: PersistPid = (path, pid) => {
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

export const resolveCliEntry = (): string => fileURLToPath(new URL("../index.js", import.meta.url))

export const watcherPid = (
  options: { readonly isProcessAlive?: ProcessProbe } = {},
): number | null => {
  const path = watchPidPath()
  if (!existsSync(path)) return null
  let pid: number
  try {
    pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10)
  } catch {
    removePidFile()
    return null
  }
  if (!Number.isFinite(pid) || pid <= 0 || !(options.isProcessAlive ?? defaultProbe)(pid)) {
    removePidFile()
    return null
  }
  return pid
}

export type StartWatcherOptions = {
  readonly cliEntry: string
  readonly nodeBin?: string
  readonly spawn?: SpawnWatcher
  readonly isProcessAlive?: ProcessProbe
  readonly withStartLock?: WatcherStartLock
  readonly persistPid?: PersistPid
}

const closeDescriptor = (descriptor: number | null): void => {
  if (descriptor === null) return
  try {
    closeSync(descriptor)
  } catch {
    return
  }
}

const spawnWatcher = (options: StartWatcherOptions): WatcherChild => {
  const logPath = watchLogPath()
  mkdirSync(dirname(logPath), { recursive: true })
  let stdoutFd: number | null = null
  let stderrFd: number | null = null
  try {
    stdoutFd = openSync(logPath, "a")
    stderrFd = openSync(logPath, "a")
    return (options.spawn ?? defaultSpawn)(
      options.nodeBin ?? process.execPath,
      [options.cliEntry, "watch"],
      {
        detached: true,
        stdio: ["ignore", stdoutFd, stderrFd],
        env: { ...process.env, SAMSKARA_HOME: configHome() },
      },
    )
  } finally {
    closeDescriptor(stdoutFd)
    closeDescriptor(stderrFd)
  }
}

export const startWatcherDaemon = (options: StartWatcherOptions): number =>
  (options.withStartLock ?? defaultStartLock)(() => {
    const existing = watcherPid(
      options.isProcessAlive ? { isProcessAlive: options.isProcessAlive } : {},
    )
    if (existing !== null) return existing

    const child = spawnWatcher(options)
    if (!child.pid) {
      child.kill("SIGTERM")
      throw new Error("failed to spawn watcher daemon")
    }
    try {
      const persistPid = options.persistPid ?? defaultPersistPid
      persistPid(watchPidPath(), child.pid)
    } catch (error) {
      child.kill("SIGTERM")
      throw error
    }
    child.unref()
    return child.pid
  })

type KillProcess = (pid: number, signal: NodeJS.Signals) => void

export type StopWatcherOptions = {
  readonly timeoutMs?: number
  readonly isProcessAlive?: ProcessProbe
  readonly kill?: KillProcess
  readonly sleep?: (ms: number) => Promise<void>
}

const defaultKill: KillProcess = (pid, signal) => process.kill(pid, signal)
const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

export const stopWatcherDaemon = async (options: StopWatcherOptions = {}): Promise<boolean> => {
  const isProcessAlive = options.isProcessAlive ?? defaultProbe
  const pid = watcherPid({ isProcessAlive })
  if (pid === null) return false
  const kill = options.kill ?? defaultKill
  try {
    kill(pid, "SIGTERM")
  } catch {
    removePidFile()
    return true
  }

  const deadline = Date.now() + (options.timeoutMs ?? 5_000)
  const sleep = options.sleep ?? defaultSleep
  while (isProcessAlive(pid) && Date.now() < deadline) await sleep(50)
  if (isProcessAlive(pid)) {
    try {
      kill(pid, "SIGKILL")
    } catch {
      removePidFile()
      return true
    }
  }
  removePidFile()
  return true
}

export const reviveWatcher = (options: Partial<StartWatcherOptions> = {}): number | null => {
  const existing = watcherPid(
    options.isProcessAlive ? { isProcessAlive: options.isProcessAlive } : {},
  )
  if (existing !== null) return existing
  try {
    return startWatcherDaemon({
      cliEntry: options.cliEntry ?? resolveCliEntry(),
      ...(options.nodeBin ? { nodeBin: options.nodeBin } : {}),
      ...(options.spawn ? { spawn: options.spawn } : {}),
      ...(options.isProcessAlive ? { isProcessAlive: options.isProcessAlive } : {}),
      ...(options.withStartLock ? { withStartLock: options.withStartLock } : {}),
      ...(options.persistPid ? { persistPid: options.persistPid } : {}),
    })
  } catch {
    return null
  }
}
