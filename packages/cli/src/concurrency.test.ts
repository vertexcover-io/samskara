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
