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
