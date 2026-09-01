const SENSITIVE_KEYS = new Set([
  "token",
  "authorization",
  "password",
  "secret",
  "accesstoken",
  "refreshtoken",
  "apikey",
  "clientsecret",
])

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const normalizedKey = (key: string): string => key.toLowerCase().replaceAll(/[_-]/g, "")

/**
 * Postgres cannot store U+0000 in `jsonb` at all, and a transcript records whatever the agent
 * wrote -- source code containing a NUL escape is ordinary content. Stripping it here, before the
 * line's uuid is derived, keeps the stored row and the hashed object identical.
 */
const withoutNul = (text: string): string =>
  text.includes("\u0000") ? text.replaceAll("\u0000", "") : text

export const redactJson = (value: unknown): unknown => {
  if (typeof value === "string") return withoutNul(value)
  if (Array.isArray(value)) return value.map(redactJson)
  if (!isObject(value)) return value

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      withoutNul(key),
      SENSITIVE_KEYS.has(normalizedKey(key)) ? "[Redacted]" : redactJson(item),
    ]),
  )
}
