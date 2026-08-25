const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const MONTH = 30 * DAY

/**
 * `Intl` rather than a dependency or a hand-rolled table: pluralisation and wording are the parts
 * that actually go wrong, and the platform already does them for every locale. What it does not
 * decide is when to stop -- that is the product's call, and it lives below.
 *
 * `numeric: "auto"` is what turns one day into "yesterday" instead of "1 day ago".
 */
const RELATIVE = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" })

const localDate = (at: Date): string => at.toLocaleDateString("en-CA")

/**
 * Every stamp in the app is rendered in the reader's own timezone. Capture writes UTC, and showing
 * some surfaces in UTC and others in local time is what made a masthead and the messages beneath it
 * disagree about when the same session ran.
 */
export const absoluteTime = (at: string | number): string => {
  const parsed = new Date(at)
  if (Number.isNaN(parsed.getTime())) return "unavailable"
  return parsed.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
}

export const clockTime = (iso: string | null): string => {
  const parsed = iso === null ? null : new Date(iso)
  if (parsed === null || Number.isNaN(parsed.getTime())) return "--:--:--"
  return parsed.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
}

/**
 * Relative while that still locates something, then a date. Past thirty days "5 weeks ago" places
 * a session no better than the date does, and reads less precisely.
 */
export const relativeTime = (iso: string, now: number = Date.now()): string => {
  const at = new Date(iso).getTime()
  if (Number.isNaN(at)) return "--"

  // Clock skew between the capturing machine and the reader is real, and must never surface as a
  // negative distance: a stamp from the future reads as now rather than counting backwards.
  const elapsed = Math.max(0, now - at)
  if (elapsed < MINUTE) return "just now"
  if (elapsed < HOUR) return RELATIVE.format(-Math.floor(elapsed / MINUTE), "minute")
  if (elapsed < DAY) return RELATIVE.format(-Math.floor(elapsed / HOUR), "hour")
  if (elapsed < MONTH) return RELATIVE.format(-Math.floor(elapsed / DAY), "day")
  return localDate(new Date(at))
}
