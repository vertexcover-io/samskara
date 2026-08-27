/** Runs `count` copies of `worker` at once and waits for all of them. */
export const runConcurrent = async (count: number, worker: () => Promise<void>): Promise<void> => {
  await Promise.all(Array.from({ length: count }, worker))
}

/**
 * `items.map(run)` with a ceiling on how many run at once.
 *
 * The shared iterator is the semaphore: every worker pulls from the same cursor, so each entry is
 * handed out exactly once and a worker that finishes early takes the next item rather than waiting
 * on a batch boundary. Results are written by index, so they stay in input order however the runs
 * interleave.
 */
export const mapWithLimit = async <T, R>(
  items: ReadonlyArray<T>,
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<ReadonlyArray<R>> => {
  const cursor = items.entries()
  const results: R[] = new Array(items.length)
  await runConcurrent(Math.min(limit, items.length), async () => {
    for (const [index, item] of cursor) {
      results[index] = await run(item)
    }
  })
  return results
}
