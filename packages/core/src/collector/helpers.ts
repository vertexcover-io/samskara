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

export type ParsedLine = { readonly lineNumber: number; readonly data: unknown }

export const iterJsonLines = (lines: ReadonlyArray<NumberedLine>): ReadonlyArray<ParsedLine> =>
  lines.flatMap(({ lineNumber, text }) => {
    const trimmed = text.trim()
    if (trimmed.length === 0) return []
    try {
      return [{ lineNumber, data: JSON.parse(trimmed) as unknown }]
    } catch {
      return []
    }
  })

export const compact = <T>(items: ReadonlyArray<T | null | undefined>): ReadonlyArray<T> =>
  items.filter((item): item is T => item !== null && item !== undefined)
