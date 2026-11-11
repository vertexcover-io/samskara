import { createLogger } from "@samskara/core"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { createWorkerShutdown } from "./shutdown.js"

const log = createLogger({ service: "shutdown-test", level: "silent" })

const setup = (reaped: number) => {
  const calls: string[] = []
  const shutdown = createWorkerShutdown({
    log,
    stopLoop: () => calls.push("stopLoop"),
    reap: () => {
      calls.push("reap")
      return reaped
    },
    exit: (code) => calls.push(`exit ${code}`),
    graceMs: 2_000,
  })
  return { calls, shutdown }
}

describe("worker shutdown", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test("a crash with 2 live agents stops the loop, reaps them and exits 1 only after the grace", () => {
    const { calls, shutdown } = setup(2)

    shutdown.stop("crash", 1)
    vi.advanceTimersByTime(1_999)
    expect(calls).toEqual(["stopLoop", "reap"])
    vi.advanceTimersByTime(1)

    expect(calls).toEqual(["stopLoop", "reap", "exit 1"])
    expect(shutdown.isStopping()).toBe(true)
  })

  test("a stop with no live agents exits 0 without waiting, and a second stop does nothing", () => {
    const { calls, shutdown } = setup(0)

    shutdown.stop("server asked")
    shutdown.stop("SIGTERM")
    vi.advanceTimersByTime(0)

    expect(calls).toEqual(["stopLoop", "reap", "exit 0"])
  })
})
