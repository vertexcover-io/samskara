import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { watchLock } from "./lockWatch.js"

describe("watching the worker lock's connection", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test("a working connection is checked on every tick and never reported lost", async () => {
    const check = vi.fn(async () => undefined)
    const lost = vi.fn()
    const watch = watchLock({ check, onLost: lost, everyMs: 1_000 })

    await vi.advanceTimersByTimeAsync(3_000)

    expect(check).toHaveBeenCalledTimes(3)
    expect(lost).not.toHaveBeenCalled()
    watch.stop()
  })

  test("a failed check reports the lock lost once and stops checking", async () => {
    const check = vi.fn(async () => {
      throw new Error("connection closed")
    })
    const lost = vi.fn()
    watchLock({ check, onLost: lost, everyMs: 1_000 })

    await vi.advanceTimersByTimeAsync(5_000)

    expect(lost).toHaveBeenCalledTimes(1)
    expect(lost.mock.calls[0]?.[0]).toBeInstanceOf(Error)
    expect(check).toHaveBeenCalledTimes(1)
  })

  test("stop ends the checks", async () => {
    const check = vi.fn(async () => undefined)
    const watch = watchLock({ check, onLost: vi.fn(), everyMs: 1_000 })

    watch.stop()
    await vi.advanceTimersByTimeAsync(3_000)

    expect(check).not.toHaveBeenCalled()
  })
})
