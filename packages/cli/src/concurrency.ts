/**
 * Runs `count` copies of `worker` at once and waits for all of them, then rethrows the first
 * failure.
 *
 * `Promise.all` would reject on the first rejection while the other workers were still running,
 * and nothing here can cancel them: they would keep working after the caller had moved on, with
 * their results reaching nobody. Settling first means a rejection is a promise that every worker
 * has stopped.
 */
export const runConcurrent = async (count: number, worker: () => Promise<void>): Promise<void> => {
  const settled = await Promise.allSettled(Array.from({ length: count }, worker))
  for (const result of settled) {
    if (result.status === "rejected") throw result.reason
  }
}

/**
 * `items.map(run)` with a ceiling on how many run at once.
 *
 * The shared iterator is the semaphore: every worker pulls from the same cursor, so each entry is
 * handed out exactly once and a worker that finishes early takes the next item rather than waiting
 * on a batch boundary. Results are written by index, so they stay in input order however the runs
 * interleave.
 */
/** Never zero for a non-empty list: a pool of no workers would report success having run nothing. */
const workerCount = (limit: number, items: number): number =>
  items === 0 ? 0 : Math.max(1, Math.min(limit, items))

export const mapWithLimit = async <T, R>(
  items: ReadonlyArray<T>,
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<ReadonlyArray<R>> => {
  const cursor = items.entries()
  const results: R[] = new Array(items.length)
  let failed = false
  await runConcurrent(workerCount(limit, items.length), async () => {
    for (const [index, item] of cursor) {
      // Stop handing out new work, but never abandon a run already going. Draining the rest of the
      // list after a failure would be worse than useless here: `runCycle` discards every result on
      // a rejection, so the whole corpus would be sent and thrown away once per cycle, forever.
      if (failed) return
      try {
        results[index] = await run(item)
      } catch (error) {
        failed = true
        throw error
      }
    }
  })
  return results
}
