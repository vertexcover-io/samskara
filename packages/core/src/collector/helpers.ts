import { createHash } from "node:crypto"

export type NumberedLine = { readonly lineNumber: number; readonly text: string }

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export class MalformedLineError extends Error {
  constructor(readonly lineNumber: number) {
    super(`Line ${lineNumber} is not a JSON object`)
    this.name = "MalformedLineError"
  }
}

export const completeLines = (content: string): ReadonlyArray<NumberedLine> =>
  content
    .split("\n")
    .slice(0, -1)
    .map((text, index) => ({ text, lineNumber: index + 1 }))

export const parseJsonLines = (
  lines: ReadonlyArray<NumberedLine>,
): ReadonlyArray<{ readonly lineNumber: number; readonly data: Record<string, unknown> }> =>
  lines.flatMap(({ lineNumber, text }) => {
    const trimmed = text.trim()
    if (trimmed.length === 0) return []
    const data: unknown = JSON.parse(trimmed)
    if (!isObject(data)) throw new MalformedLineError(lineNumber)
    return [{ lineNumber, data }]
  })

export const compact = <T>(items: ReadonlyArray<T | null | undefined>): ReadonlyArray<T> =>
  items.filter((item): item is T => item !== null && item !== undefined)

const uuidBytes = (uuid: string): Buffer => Buffer.from(uuid.replaceAll("-", ""), "hex")
const formatUuid = (bytes: Buffer): string => {
  const hex = bytes.toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** RFC 4122 name-based uuid: the same namespace and name always yield the same id. */
export const uuidV5 = (namespace: string, name: string): string => {
  const digest = createHash("sha1")
    .update(Buffer.concat([uuidBytes(namespace), Buffer.from(name, "utf8")]))
    .digest()
    .subarray(0, 16)
  const bytes = Buffer.from(digest)
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  return formatUuid(bytes)
}
