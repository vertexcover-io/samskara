import type pino from "pino"

/** Same grace the server used: lets each review's `finally` remove its workspace. */
export const SHUTDOWN_GRACE_MS = 2_000

export type WorkerShutdown = {
  /** Stops the loop, reaps the agents, then exits with `code`; only the first call counts. */
  readonly stop: (reason: string, code?: number) => void
  readonly isStopping: () => boolean
}

/**
 * One stop path for a stop request and a crash alike. Agents run detached, so a worker that exits
 * without reaping them leaves them running beside the next worker's run of the same review.
 */
export const createWorkerShutdown = (deps: {
  readonly log: pino.Logger
  readonly stopLoop: () => void
  readonly reap: () => number
  readonly exit: (code: number) => void
  readonly graceMs?: number
}): WorkerShutdown => {
  let stopping = false
  return {
    isStopping: () => stopping,
    stop: (reason, code = 0) => {
      if (stopping) return
      stopping = true
      // Before the reap, so the killed tries are not counted as failed and nothing new starts.
      deps.stopLoop()
      const reaped = deps.reap()
      deps.log.info({ reason, reaped }, "worker stopping")
      const graceMs = reaped === 0 ? 0 : (deps.graceMs ?? SHUTDOWN_GRACE_MS)
      setTimeout(() => deps.exit(code), graceMs).unref()
    },
  }
}
