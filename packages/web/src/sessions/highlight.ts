/**
 * Matches are delimited with STX/ETX rather than markup: snippet text comes from tool output and
 * must never reach the DOM as HTML.
 */
export const MATCH_START = ""
export const MATCH_END = ""

export type SnippetSegment = {
  readonly text: string
  readonly match: boolean
  /** Offset in the original snippet — a stable React key, unlike an array index. */
  readonly start: number
}

/** An unpaired delimiter stays ordinary text: a snippet is a fragment, so a match can straddle the cut. */
export const splitHighlights = (snippet: string): ReadonlyArray<SnippetSegment> => {
  const segments: SnippetSegment[] = []
  let rest = snippet
  let offset = 0

  while (rest.length > 0) {
    const start = rest.indexOf(MATCH_START)
    if (start === -1) break

    const end = rest.indexOf(MATCH_END, start + 1)
    if (end === -1) break

    if (start > 0) segments.push({ text: rest.slice(0, start), match: false, start: offset })
    segments.push({ text: rest.slice(start + 1, end), match: true, start: offset + start + 1 })
    offset += end + 1
    rest = rest.slice(end + 1)
  }

  if (rest.length > 0) segments.push({ text: rest, match: false, start: offset })
  return segments.filter((segment) => segment.text.length > 0)
}
