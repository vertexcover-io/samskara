const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

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

export const relativeTime = (iso: string, now: number = Date.now()): string => {
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return "unknown"

  const elapsed = now - parsed.getTime()
  if (elapsed < MINUTE) return "just now"
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min ago`
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} h ago`
  if (elapsed < 2 * DAY) return "Yesterday"
  if (elapsed < 7 * DAY) return `${Math.floor(elapsed / DAY)} d ago`
  if (elapsed < 30 * DAY) return `${Math.floor(elapsed / (7 * DAY))} wk ago`
  return parsed.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })
}
