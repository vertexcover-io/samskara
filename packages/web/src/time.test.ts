import { describe, expect, test } from "vitest"
import { absoluteTime, clockTime, relativeTime } from "./time.js"

// A transcript is read soon after it is written, so the near ranges are the ones that matter.
describe("relativeTime", () => {
  const now = Date.parse("2026-08-01T12:00:00.000Z")
  const ago = (ms: number) => relativeTime(new Date(now - ms).toISOString(), now)

  test("reads in the largest unit that still counts whole", () => {
    expect(ago(30_000)).toBe("just now")
    expect(ago(60_000)).toBe("1 minute ago")
    expect(ago(45 * 60_000)).toBe("45 minutes ago")
    expect(ago(2 * 3_600_000)).toBe("2 hours ago")
    expect(ago(3 * 86_400_000)).toBe("3 days ago")
  })

  // Naming the day is what a reader recognises; "1 day ago" makes them do the arithmetic.
  test("the day either side of now is named rather than counted", () => {
    expect(ago(86_400_000)).toBe("yesterday")
  })

  test("falls back to a date once relative wording stops locating anything", () => {
    expect(ago(90 * 86_400_000)).toBe("2026-05-03")
  })

  // Clock skew between the capturing machine and the reader must not read as "in -3 minutes".
  test("a timestamp from the future reads as now rather than counting backwards", () => {
    expect(relativeTime(new Date(now + 5 * 60_000).toISOString(), now)).toBe("just now")
  })

  test("an unparseable timestamp says nothing rather than inventing a distance", () => {
    expect(relativeTime("not a date", now)).toBe("--")
  })
})

describe("absoluteTime", () => {
  test("carries the moment to the minute, so a relative stamp costs no precision on hover", () => {
    expect(absoluteTime("2026-02-01T09:30:00.000Z")).toBe("Feb 1, 2026, 09:30")
  })

  test("an unparseable moment is named as unavailable rather than echoed back", () => {
    expect(absoluteTime("not a date")).toBe("unavailable")
  })
})

describe("clockTime", () => {
  test("a missing or unparseable stamp holds the column rather than collapsing it", () => {
    expect(clockTime(null)).toBe("--:--:--")
    expect(clockTime("not a date")).toBe("--:--:--")
  })

  test("reads the transcript clock to the second", () => {
    expect(clockTime("2026-02-01T09:30:15.000Z")).toBe("09:30:15")
  })
})
