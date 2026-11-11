import { type ChildProcess, fork } from "node:child_process"
import { extname } from "node:path"
import { fileURLToPath } from "node:url"
import type pino from "pino"
import { ALIVE, NEW_WORK, STOP } from "./messages.js"

/** No alive for this long and the worker is taken for hung. */
export const ALIVE_TIMEOUT_MS = 2 * 60 * 1000
const CHECK_EVERY_MS = 30_000
/** A worker that lived this long was healthy: its exit is restarted at once. */
const STABLE_AFTER_MS = 60_000
const MAX_RESTART_DELAY_MS = 60_000

/** What the supervisor needs of a child process; a real one from `fork`, or a test fake. */
export type WorkerChild = Pick<ChildProcess, "send" | "kill" | "on" | "connected">

export type WorkerSupervisor = {
  /** Tells the current worker a row was set to waiting. Never throws. */
  readonly notify: () => void
  /** Stops the worker and starts no other; resolves once it has exited. */
  readonly stop: () => Promise<void>
}

/**
 * The worker's own file beside this one: `main.ts` under tsx in dev, `main.js` from `dist`.
 * `fork` passes this process's `execArgv`, so tsx's loader comes along in dev.
 */
const forkWorker = (): WorkerChild => {
  const here = fileURLToPath(import.meta.url)
  const entry = fileURLToPath(new URL(`./main${extname(here)}`, import.meta.url))
  return fork(entry, [], { stdio: "inherit" })
}

export const startWorkerSupervisor = (deps: {
  readonly log: pino.Logger
  readonly spawn?: () => WorkerChild
  readonly now?: () => number
  readonly aliveTimeoutMs?: number
  readonly checkEveryMs?: number
}): WorkerSupervisor => {
  const spawn = deps.spawn ?? forkWorker
  const now = deps.now ?? Date.now
  const aliveTimeoutMs = deps.aliveTimeoutMs ?? ALIVE_TIMEOUT_MS
  let stopped = false
  let lastAlive = now()
  /** Exits in a row of workers that died young; with Postgres down every worker does. */
  let quickExits = 0
  let restart: NodeJS.Timeout | undefined
  const exited = new WeakSet<WorkerChild>()

  const start = (): WorkerChild => {
    const current = spawn()
    const startedAt = now()
    lastAlive = startedAt
    current.on("message", (message) => {
      if (message === ALIVE && current === child) lastAlive = now()
    })
    // A failed send or fork arrives as an 'error' event, which would crash the server unheard.
    // A worker that died also exits, and the exit handler restarts it.
    current.on("error", (error) => deps.log.warn({ err: error }, "worker process error"))
    current.on("exit", (code, signal) => {
      exited.add(current)
      if (stopped || current !== child) return
      if (now() - startedAt >= STABLE_AFTER_MS) quickExits = 0
      const delayMs =
        quickExits === 0 ? 0 : Math.min(1_000 * 2 ** (quickExits - 1), MAX_RESTART_DELAY_MS)
      quickExits += 1
      deps.log.warn({ code, signal, delayMs }, "worker exited; starting a new one")
      if (delayMs === 0) {
        child = start()
        return
      }
      restart = setTimeout(() => {
        restart = undefined
        if (!stopped) child = start()
      }, delayMs)
    })
    return current
  }

  let child: WorkerChild = start()
  const timer = setInterval(() => {
    if (stopped || restart !== undefined || now() - lastAlive < aliveTimeoutMs) return
    deps.log.warn({ silentMs: now() - lastAlive }, "worker sent no alive; replacing it")
    const hung = child
    // The replacement first, so the hung worker's exit is from a child that is no longer current.
    child = start()
    hung.kill("SIGKILL")
  }, deps.checkEveryMs ?? CHECK_EVERY_MS)
  timer.unref()

  return {
    notify: () => {
      if (!child.connected) return
      try {
        child.send(NEW_WORK)
      } catch (error) {
        deps.log.warn({ err: error }, "could not tell the worker about new work")
      }
    },
    stop: () => {
      stopped = true
      clearInterval(timer)
      clearTimeout(restart)
      const current = child
      if (exited.has(current)) return Promise.resolve()
      const gone = new Promise<void>((resolve) => current.on("exit", () => resolve()))
      try {
        if (current.connected) current.send(STOP)
      } catch (error) {
        deps.log.warn({ err: error }, "could not tell the worker to stop")
      }
      current.kill("SIGTERM")
      return gone
    },
  }
}
