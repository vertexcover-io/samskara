import type { FileSystem } from "./fs.js"

export type NumberedLine = { readonly lineNumber: number; readonly text: string }

export type ReadNewLinesResult = {
  readonly lines: ReadonlyArray<NumberedLine>
  readonly lastLineProcessed: number
}

export const readNewLines = async (
  fs: FileSystem,
  path: string,
  fromLine: number,
): Promise<ReadNewLinesResult> => {
  const content = await fs.readFile(path)
  const complete = content.split("\n").slice(0, -1)

  const lines = complete
    .slice(fromLine)
    .map((text, index) => ({ lineNumber: fromLine + index + 1, text }))

  return { lines, lastLineProcessed: complete.length }
}

export type JsonLineOutcome =
  | { readonly kind: "object"; readonly lineNumber: number; readonly data: Record<string, unknown> }
  | {
      readonly kind: "skip"
      readonly lineNumber: number
      readonly reason: "blank" | "malformedJson" | "nonObjectJson"
    }

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const parseJsonLine = ({ lineNumber, text }: NumberedLine): JsonLineOutcome => {
  const trimmed = text.trim()
  if (trimmed.length === 0) return { kind: "skip", lineNumber, reason: "blank" }

  try {
    const data: unknown = JSON.parse(trimmed)
    if (!isObject(data)) return { kind: "skip", lineNumber, reason: "nonObjectJson" }
    return { kind: "object", lineNumber, data }
  } catch {
    return { kind: "skip", lineNumber, reason: "malformedJson" }
  }
}

export const iterJsonLines = (lines: ReadonlyArray<NumberedLine>): ReadonlyArray<JsonLineOutcome> =>
  lines.map(parseJsonLine)

export const compact = <T>(items: ReadonlyArray<T | null | undefined>): ReadonlyArray<T> =>
  items.filter((item): item is T => item !== null && item !== undefined)
