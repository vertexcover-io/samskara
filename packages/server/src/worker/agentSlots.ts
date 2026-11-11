import type { HarnessRunner } from "@samskara/core"

export type AgentSlots = HarnessRunner & {
  /**
   * The worker is going away: refuse every waiting and later call. An agent started after the
   * reap would outlive the worker, since agents run detached.
   */
  readonly stop: () => void
}

type Waiter = { readonly resolve: () => void; readonly reject: (error: Error) => void }

const stoppedError = (): Error => new Error("agent slots stopped")

/** Runs at most `slots` agent calls at once; the rest wait in the order they were made. */
export const withAgentSlots = (runner: HarnessRunner, slots: number): AgentSlots => {
  let running = 0
  let stopped = false
  const waiting: Waiter[] = []

  const acquire = (): Promise<void> => {
    if (stopped) return Promise.reject(stoppedError())
    if (running < slots) {
      running += 1
      return Promise.resolve()
    }
    // The slot passes straight to the next waiter, so `running` never drops and rises again.
    return new Promise((resolve, reject) => waiting.push({ resolve, reject }))
  }

  const release = (): void => {
    const next = waiting.shift()
    if (next === undefined) running -= 1
    else next.resolve()
  }

  return {
    run: async (input) => {
      await acquire()
      try {
        return await runner.run(input)
      } finally {
        release()
      }
    },
    stop: () => {
      stopped = true
      for (const waiter of waiting.splice(0)) waiter.reject(stoppedError())
    },
  }
}
