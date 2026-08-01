import { describe, expect, test } from "vitest"
import { SEARCH_TEXT_MAX_BYTES } from "./constants.js"
import { type TextSourceRow, type ToolContext, buildEmbedText, buildSearchText } from "./text.js"

const messageRow = (id: string, content: unknown): TextSourceRow => ({
  id,
  msgType: "message",
  role: "user",
  content,
})

describe("buildSearchText / buildEmbedText", () => {
  test("an image content part contributes nothing to either projection", () => {
    const rows = [
      messageRow("m1", {
        type: "image",
        value: "aGVsbG8=",
        mediaType: "image/png",
        encoding: "base64",
      }),
    ]

    expect(buildSearchText(rows, new Map())).toBe("")
    expect(buildEmbedText(rows, new Map())).toBe("")
  })

  test("D2: a tool result appears in searchText and is absent from embedText", () => {
    const rows: ReadonlyArray<TextSourceRow> = [
      { id: "call-1", msgType: "toolCall", role: null, content: null },
      { id: "result-1", msgType: "toolResult", role: null, content: null },
    ]
    const tools = new Map<string, ToolContext>([
      ["call-1", { toolName: "Bash", toolInput: { command: "ls" }, result: undefined }],
      ["result-1", { toolName: "Bash", toolInput: undefined, result: "file-a.txt file-b.txt" }],
    ])

    expect(buildSearchText(rows, tools)).toContain("file-a.txt")
    expect(buildEmbedText(rows, tools)).not.toContain("file-a.txt")
    expect(buildEmbedText(rows, tools)).toContain("Bash")
  })

  test("R3: a tool result far over the cap is truncated; the prose before it survives", () => {
    const rows: ReadonlyArray<TextSourceRow> = [
      messageRow("m1", { type: "text", value: "investigating the memory leak" }),
      { id: "call-1", msgType: "toolCall", role: null, content: null },
      { id: "result-1", msgType: "toolResult", role: null, content: null },
    ]
    const hugeResult = "x".repeat(SEARCH_TEXT_MAX_BYTES * 2)
    const tools = new Map<string, ToolContext>([
      ["call-1", { toolName: "Read", toolInput: { path: "big.log" }, result: undefined }],
      ["result-1", { toolName: "Read", toolInput: undefined, result: hugeResult }],
    ])

    const searchText = buildSearchText(rows, tools)

    expect(searchText).toContain("investigating the memory leak")
    expect(Buffer.byteLength(searchText, "utf8")).toBeLessThan(SEARCH_TEXT_MAX_BYTES * 1.1)
  })

  test("R3: a huge tool INPUT cannot push searchText past the cap", () => {
    // The cap existed to keep `to_tsvector` under Postgres's 1 MB ceiling, but only the
    // tool-result tail was truncated. A tool input lands in the prose head -- a Write call
    // carrying a large file body is exactly that -- and the head was unbounded, so the GIN
    // expression index threw `string is too long for tsvector` at insert time and the whole
    // batched chunk write for that session was lost.
    const rows: ReadonlyArray<TextSourceRow> = [
      messageRow("m1", { type: "text", value: "committing the generated client" }),
      { id: "call-1", msgType: "toolCall", role: null, content: null },
    ]
    const tools = new Map<string, ToolContext>([
      [
        "call-1",
        {
          toolName: "Write",
          toolInput: {
            file_path: "src/generated.ts",
            content: "x".repeat(SEARCH_TEXT_MAX_BYTES * 3),
          },
          result: undefined,
        },
      ],
    ])

    const searchText = buildSearchText(rows, tools)
    const embedText = buildEmbedText(rows, tools)

    expect(Buffer.byteLength(searchText, "utf8")).toBeLessThanOrEqual(SEARCH_TEXT_MAX_BYTES)
    expect(Buffer.byteLength(embedText, "utf8")).toBeLessThanOrEqual(SEARCH_TEXT_MAX_BYTES)
    // The prose still survives -- truncation must not cost the part worth keeping.
    expect(searchText).toContain("committing the generated client")
    expect(searchText).toContain("Write")
  })

  test("R3: many distinct tokens stay under the cap, since it is lexeme count that breaks tsvector", () => {
    const distinct = Array.from({ length: 200_000 }, (_, i) => `tok${i}`).join(" ")
    const rows = [messageRow("m1", { type: "text", value: distinct })]

    expect(Buffer.byteLength(buildSearchText(rows, new Map()), "utf8")).toBeLessThanOrEqual(
      SEARCH_TEXT_MAX_BYTES,
    )
  })

  test("R3: the cap holds for multi-byte text, where a naive byte slice would overshoot it", () => {
    // Every emoji is 4 bytes, so the cap lands mid-sequence. Cutting there and letting `toString`
    // insert a 3-byte U+FFFD would return more bytes than the cap allows.
    // The leading ASCII char is load-bearing: without it every emoji is 4 bytes and the cap lands
    // exactly on a boundary, so the cut never lands mid-sequence and the test proves nothing.
    const value = `x${"🙂".repeat(SEARCH_TEXT_MAX_BYTES)}`
    const rows = [messageRow("m1", { type: "text", value })]

    const searchText = buildSearchText(rows, new Map())

    expect(Buffer.byteLength(searchText, "utf8")).toBeLessThanOrEqual(SEARCH_TEXT_MAX_BYTES)
    expect(searchText).not.toContain("\uFFFD")
  })

  test("reasoning content is included, and tool names with inputs appear in both projections", () => {
    const rows: ReadonlyArray<TextSourceRow> = [
      {
        id: "m1",
        msgType: "message",
        role: "assistant",
        content: { type: "reasoning", value: "thinking it through" },
      },
      { id: "call-1", msgType: "toolCall", role: null, content: null },
    ]
    const tools = new Map<string, ToolContext>([
      ["call-1", { toolName: "Grep", toolInput: { pattern: "TODO" }, result: undefined }],
    ])

    const searchText = buildSearchText(rows, tools)
    const embedText = buildEmbedText(rows, tools)

    expect(searchText).toContain("thinking it through")
    expect(searchText).toContain("Grep")
    expect(searchText).toContain("TODO")
    expect(embedText).toContain("thinking it through")
    expect(embedText).toContain("Grep")
    expect(embedText).toContain("TODO")
  })
})
