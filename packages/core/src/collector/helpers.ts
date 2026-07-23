import type { FileSystem } from "./fs.js"
import type { FileState, LineCursor } from "./types.js"

export type NumberedLine = { readonly lineNumber: number; readonly text: string }

export type ReadNewLinesResult = {
  readonly lines: ReadonlyArray<NumberedLine>
  readonly cursor: LineCursor
}

const lastProcessed = (prev: FileState | null): number =>
  prev && prev.cursor.kind === "line" ? prev.cursor.lastLineProcessed : 0

export const readNewLines = async (
  fs: FileSystem,
  path: string,
  prev: FileState | null,
): Promise<ReadNewLinesResult> => {
  const already = lastProcessed(prev)
  const content = await fs.readFile(path)
  const complete = content.split("\n").slice(0, -1)

  const lines = complete
    .slice(already)
    .map((text, index) => ({ lineNumber: already + index + 1, text }))

  return { lines, cursor: { kind: "line", lastLineProcessed: complete.length } }
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
