import { describe, expect, test } from "vitest"
import { mapWithLimit, runConcurrent } from "./concurrency.js"

const deferred = () => {
  let release = (): void => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  return { gate, release }
}

describe("runConcurrent", () => {
  test("starts exactly `count` copies and waits for all of them", async () => {
    let started = 0
    let finished = 0
    const { gate, release } = deferred()

    const all = runConcurrent(3, async () => {
      started += 1
      await gate
      finished += 1
    })

    await Promise.resolve()
    expect(started).toBe(3)
    expect(finished).toBe(0)

    release()
    await all
    expect(finished).toBe(3)
  })

  /**
   * `Promise.all` rejects on the first rejection but cannot cancel the others, and an array
   * iterator has no `return()` to close, so the survivors would keep pulling items and sending
   * long after the caller had moved on -- overlapping the next watch cycle.
   */
  test("waits for every worker to settle before rejecting, so none outlive the call", async () => {
    let finished = 0
    let calls = 0

    const failing = runConcurrent(3, async () => {
      const mine = calls++
      await new Promise((resolve) => setTimeout(resolve, mine === 0 ? 0 : 10))
      if (mine === 0) throw new Error("boom")
      finished += 1
    })

    await expect(failing).rejects.toThrow("boom")
    expect(finished).toBe(2)
  })

  test("reports the first rejection rather than swallowing it", async () => {
    let started = 0
    await expect(
      runConcurrent(2, async () => {
        started += 1
        throw new Error(`worker ${started}`)
      }),
    ).rejects.toThrow("worker 1")
  })
})

describe("mapWithLimit", () => {
  test("never runs more than `limit` at once", async () => {
    let inFlight = 0
    let peak = 0

    await mapWithLimit(
      Array.from({ length: 20 }, (_, index) => index),
      4,
      async (item) => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 1))
        inFlight -= 1
        return item
      },
    )

    expect(peak).toBe(4)
  })

  test("results keep the order of the input, not the order they finished in", async () => {
    const results = await mapWithLimit([30, 20, 10, 0], 4, async (delay) => {
      await new Promise((resolve) => setTimeout(resolve, delay))
      return delay
    })

    expect(results).toEqual([30, 20, 10, 0])
  })

  test("an empty list starts no workers at all", async () => {
    let calls = 0
    const results = await mapWithLimit([], 4, async () => {
      calls += 1
    })

    expect(calls).toBe(0)
    expect(results).toEqual([])
  })

  test("fewer items than the limit starts one worker per item", async () => {
    let peak = 0
    let inFlight = 0

    await mapWithLimit([1, 2], 8, async (item) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 1))
      inFlight -= 1
      return item
    })

    expect(peak).toBe(2)
  })
})

describe("mapWithLimit failure", () => {
  /**
   * Stops handing out work without abandoning what is already running. Draining the rest would be
   * worse than useless in `runCycle`: it discards every result on a rejection, so the whole corpus
   * would be sent and thrown away once a cycle, forever.
   */
  test("a failure stops new items starting, but lets the running ones finish", async () => {
    const started: number[] = []
    const done: number[] = []

    const failing = mapWithLimit([0, 1, 2, 3], 2, async (item) => {
      started.push(item)
      if (item === 0) throw new Error("boom")
      await new Promise((resolve) => setTimeout(resolve, 5))
      done.push(item)
      return item
    })

    await expect(failing).rejects.toThrow("boom")
    expect(started).toEqual([0, 1])
    expect(done).toEqual([1])
  })

  test("a limit below one still runs the work rather than silently reporting an empty pass", async () => {
    const results = await mapWithLimit([1, 2], 0, async (item) => item * 2)

    expect(results).toEqual([2, 4])
  })
})
