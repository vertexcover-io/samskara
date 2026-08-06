import { describe, expect, test } from "vitest"
import { type ChunkSourceRow, deriveTurns } from "./turns.js"

let counter = 0
const row = (fields: Partial<ChunkSourceRow> & { readonly lineNumber: number }): ChunkSourceRow => {
  counter += 1
  return {
    id: `msg-${counter}`,
    trackId: "main",
    agentId: null,
    msgType: "message",
    role: null,
    ...fields,
  }
}

const userRow = (lineNumber: number, overrides: Partial<ChunkSourceRow> = {}): ChunkSourceRow =>
  row({ lineNumber, msgType: "message", role: "user", ...overrides })

const assistantRow = (
  lineNumber: number,
  overrides: Partial<ChunkSourceRow> = {},
): ChunkSourceRow => row({ lineNumber, msgType: "message", role: "assistant", ...overrides })

describe("deriveTurns", () => {
  test("D3/D6: two user messages on one track produce one closed turn; the second (in-flight) turn is absent", () => {
    const first = userRow(1)
    const second = userRow(3)

    const turns = deriveTurns([first, second])

    expect(turns).toEqual([
      {
        trackId: "main",
        agentId: null,
        startLineNumber: 1,
        endLineNumber: 2,
        anchorMessageId: first.id,
      },
    ])
  })

  test("D3/D6: a third user message later closes the second turn, which now appears", () => {
    const first = userRow(1)
    const second = userRow(3)
    const third = userRow(5)

    const turns = deriveTurns([first, second, third])

    expect(turns).toEqual([
      {
        trackId: "main",
        agentId: null,
        startLineNumber: 1,
        endLineNumber: 2,
        anchorMessageId: first.id,
      },
      {
        trackId: "main",
        agentId: null,
        startLineNumber: 3,
        endLineNumber: 4,
        anchorMessageId: second.id,
      },
    ])
  })

  test("D4: two interleaved tracks produce two independent turn sets, neither spanning the other", () => {
    const mainOpen = userRow(1, { trackId: "main" })
    const subOpen = userRow(2, { trackId: "agent:a", agentId: "a" })
    const mainClose = userRow(3, { trackId: "main" })
    const subClose = userRow(4, { trackId: "agent:a", agentId: "a" })

    const turns = deriveTurns([mainOpen, subOpen, mainClose, subClose])

    expect(turns).toEqual([
      {
        trackId: "main",
        agentId: null,
        startLineNumber: 1,
        endLineNumber: 2,
        anchorMessageId: mainOpen.id,
      },
      {
        trackId: "agent:a",
        agentId: "a",
        startLineNumber: 2,
        endLineNumber: 3,
        anchorMessageId: subOpen.id,
      },
    ])
  })

  test("R6: a track whose rows are all non-user produces no turns", () => {
    const turns = deriveTurns([
      assistantRow(1),
      row({ lineNumber: 2, msgType: "toolCall" }),
      row({ lineNumber: 3, msgType: "toolResult" }),
    ])

    expect(turns).toEqual([])
  })

  test("turnEvent rows do not close a turn", () => {
    const open = userRow(1)
    const turnEvent = row({ lineNumber: 2, msgType: "turnEvent" })
    const close = userRow(3)

    const turns = deriveTurns([open, turnEvent, close])

    expect(turns).toEqual([
      {
        trackId: "main",
        agentId: null,
        startLineNumber: 1,
        endLineNumber: 2,
        anchorMessageId: open.id,
      },
    ])
  })

  test("D7: the range covers every row between the opener and the next opener, including a null-role row", () => {
    const open = userRow(1)
    const nullRole = row({ lineNumber: 2, msgType: "custom" })
    const assistant = assistantRow(3)
    const close = userRow(4)

    const turns = deriveTurns([open, nullRole, assistant, close])

    expect(turns).toEqual([
      {
        trackId: "main",
        agentId: null,
        startLineNumber: 1,
        endLineNumber: 3,
        anchorMessageId: open.id,
      },
    ])
  })

  test("rows are turn-derived in lineNumber order regardless of input order", () => {
    const first = userRow(1)
    const second = userRow(3)

    const turns = deriveTurns([second, first])

    expect(turns).toEqual([
      {
        trackId: "main",
        agentId: null,
        startLineNumber: 1,
        endLineNumber: 2,
        anchorMessageId: first.id,
      },
    ])
  })
})
