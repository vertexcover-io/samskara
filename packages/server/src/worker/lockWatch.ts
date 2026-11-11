export type LockWatch = { readonly stop: () => void }

/**
 * The worker lock is a session lock: Postgres drops it the moment its connection goes, after a
 * database restart or a network cut, while this process would carry on as if it still held it.
 * A cheap query on that connection every `everyMs` notices, and `onLost` runs once.
 */
export const watchLock = (deps: {
  readonly check: () => Promise<unknown>
  readonly onLost: (error: unknown) => void
  readonly everyMs: number
}): LockWatch => {
  let stopped = false
  const timer = setInterval(() => {
    deps.check().catch((error: unknown) => {
      if (stopped) return
      stopped = true
      clearInterval(timer)
      deps.onLost(error)
    })
  }, deps.everyMs)
  timer.unref()
  return {
    stop: () => {
      stopped = true
      clearInterval(timer)
    },
  }
}
