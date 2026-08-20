import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { useDebouncedValue } from "./useDebouncedValue.js"

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("SC19: the debounce hook reports one value after rapid changes", () => {
  test("four changes inside the delay report only the final value, and nothing before the delay elapses", () => {
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, 250), {
      initialProps: { value: "a" },
    })

    rerender({ value: "ab" })
    act(() => {
      vi.advanceTimersByTime(100)
    })
    rerender({ value: "abc" })
    act(() => {
      vi.advanceTimersByTime(100)
    })
    rerender({ value: "abcd" })

    // Under 250ms since the last change: the hook still reports the value it started with.
    expect(result.current).toBe("a")

    act(() => {
      vi.advanceTimersByTime(249)
    })
    expect(result.current).toBe("a")

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(result.current).toBe("abcd")
  })
})
