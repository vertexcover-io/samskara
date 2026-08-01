import { describe, expect, test } from "vitest"
import { timeAgo } from "./ChangesView.js"

// A transcript is read soon after it is written, so the near ranges are the ones that matter.
describe("timeAgo", () => {
  const now = Date.parse("2026-08-01T12:00:00.000Z")
  const ago = (ms: number) => timeAgo(new Date(now - ms).toISOString(), now)

  test("reads in the largest unit that still counts whole", () => {
    expect(ago(30_000)).toBe("just now")
    expect(ago(60_000)).toBe("1 minute ago")
    expect(ago(45 * 60_000)).toBe("45 minutes ago")
    expect(ago(2 * 3_600_000)).toBe("2 hours ago")
    expect(ago(3 * 86_400_000)).toBe("3 days ago")
  })

  test("falls back to a date once relative wording stops locating anything", () => {
    expect(ago(90 * 86_400_000)).toBe("2026-05-03")
  })

  // Clock skew between the capturing machine and the reader must not read as "in -3 minutes".
  test("a timestamp from the future reads as now rather than counting backwards", () => {
    expect(timeAgo(new Date(now + 5 * 60_000).toISOString(), now)).toBe("just now")
  })

  test("an unparseable timestamp says nothing rather than inventing a distance", () => {
    expect(timeAgo("not a date", now)).toBe("--")
  })
})
