import { SEARCH_TEXT_MAX_BYTES } from "./constants.js"

/** The subset of `messages` the two text projections need. */
export type TextSourceRow = {
  readonly id: string
  readonly msgType: string
  readonly role: string | null
  readonly content: unknown
}

/** A toolCall/toolResult row's projected fields, keyed by the owning message's id. */
export type ToolContext = {
  readonly toolName: string
  readonly toolInput: unknown
  readonly result: unknown
}

// `messages.content` is a jsonb discriminated union, not a string (packages/core/src/ingest/
// types.ts:33-47): `text` and `reasoning` carry a `value` string, `image` carries a base64
// payload that must never be embedded or indexed.
const projectContent = (content: unknown): string => {
  if (typeof content !== "object" || content === null) return ""
  const { type, value } = content as { type?: unknown; value?: unknown }
  if ((type === "text" || type === "reasoning") && typeof value === "string") return value
  return ""
}

const stringify = (value: unknown): string => {
  if (value === undefined || value === null) return ""
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value)
  } catch {
    return ""
  }
}

const truncateToBytes = (text: string, maxBytes: number): string => {
  if (maxBytes <= 0) return ""
  const buf = Buffer.from(text, "utf8")
  if (buf.byteLength <= maxBytes) return text

  // Walk back off any UTF-8 continuation byte (10xxxxxx) so the cut never splits a code point.
  // Cutting mid-sequence is not merely lossy: `toString` replaces the fragment with U+FFFD, which
  // is three bytes, so a naive slice can come back *over* the cap it was supposed to enforce.
  const isContinuation = (byte: number | undefined): boolean =>
    byte !== undefined && (byte & 0xc0) === 0x80

  let end = maxBytes
  while (end > 0 && isContinuation(buf[end])) end -= 1
  return buf.subarray(0, end).toString("utf8")
}

type Projection = {
  readonly prose: ReadonlyArray<string>
  readonly toolResults: ReadonlyArray<string>
}

// User prose, assistant text, and tool names with their inputs are the shared projection.
// Tool results are collected separately: they belong in searchText only, and are the part R3
// truncates first when the combined text would exceed the cap.
const project = (
  rows: ReadonlyArray<TextSourceRow>,
  tools: ReadonlyMap<string, ToolContext>,
): Projection => {
  const prose: string[] = []
  const toolResults: string[] = []

  for (const row of rows) {
    if (row.msgType === "message") {
      const text = projectContent(row.content)
      if (text) prose.push(text)
      continue
    }

    const tool = tools.get(row.id)
    if (!tool) continue

    if (row.msgType === "toolCall") {
      prose.push(tool.toolName)
      const input = stringify(tool.toolInput)
      if (input) prose.push(input)
      continue
    }

    if (row.msgType === "toolResult") {
      const result = stringify(tool.result)
      if (result) toolResults.push(result)
    }
  }

  return { prose, toolResults }
}

/**
 * User prose, assistant text, and tool names with their key inputs -- never tool results.
 *
 * Capped for the same reason `buildSearchText` is, plus one of its own: this text is POSTed to an
 * embedding provider, and a tool input carrying a whole file body would blow the provider's token
 * limit and leave the chunk permanently unembedded.
 */
export const buildEmbedText = (
  rows: ReadonlyArray<TextSourceRow>,
  tools: ReadonlyMap<string, ToolContext>,
): string => truncateToBytes(project(rows, tools).prose.join("\n"), SEARCH_TEXT_MAX_BYTES)

/**
 * Capped at both ends: tool results first (prose is worth more), then the prose head, since a tool
 * input lands there and can be a whole file body. Exceeding the cap makes the GIN index throw at
 * INSERT, losing every chunk in the batch.
 */
export const buildSearchText = (
  rows: ReadonlyArray<TextSourceRow>,
  tools: ReadonlyMap<string, ToolContext>,
): string => {
  const { prose, toolResults } = project(rows, tools)
  const head = truncateToBytes(prose.join("\n"), SEARCH_TEXT_MAX_BYTES)
  const tail = toolResults.join("\n")

  const remaining = Math.max(0, SEARCH_TEXT_MAX_BYTES - Buffer.byteLength(head, "utf8"))
  const truncatedTail = truncateToBytes(tail, remaining)

  return truncatedTail ? `${head}\n${truncatedTail}` : head
}
