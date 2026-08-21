import { describe, expect, test, vi } from "vitest"
import { QueryMetrics, queryOperationName } from "./client.js"

describe("database query instrumentation", () => {
  test("uses low-cardinality operation names and never retains SQL or parameters", () => {
    expect(queryOperationName(" select * from secret_values where token = $1")).toBe("select")
    expect(queryOperationName("WITH scoped AS (SELECT 1) SELECT * FROM scoped")).toBe("other")
    expect(queryOperationName("DELETE FROM sessions")).toBe("delete")
  })

  test("tracks concurrent explicit operations without inventing a pool-wait association", async () => {
    const metrics = new QueryMetrics()
    const completeFirst = vi.fn<() => void>()
    const completeSecond = vi.fn<() => void>()
    const first = new Promise<void>((resolve) => completeFirst.mockImplementation(resolve))
    const second = new Promise<void>((resolve) => completeSecond.mockImplementation(resolve))

    const firstOperation = metrics.track("select", () => first)
    const secondOperation = metrics.track("insert", () => second)
    expect(metrics.snapshot()).toEqual({ activeOperations: 2, activeOperationHighWater: 2 })

    completeSecond()
    await secondOperation
    expect(metrics.snapshot()).toEqual({ activeOperations: 1, activeOperationHighWater: 2 })

    completeFirst()
    await firstOperation
    expect(metrics.snapshot()).toEqual({ activeOperations: 0, activeOperationHighWater: 2 })
  })

  test("emits per-operation duration only after each operation settles", async () => {
    const metrics = new QueryMetrics()
    const events: Array<unknown> = []
    await metrics.track(
      "select",
      async () => "ok",
      (event) => events.push(event),
    )

    expect(events).toEqual([
      expect.objectContaining({
        operation: "select",
        operationMs: expect.any(Number),
        activeOperations: 0,
        activeOperationHighWater: 1,
      }),
    ])
  })
})
