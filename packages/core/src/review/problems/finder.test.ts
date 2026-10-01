import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import type { SessionExport, SessionExportRecord } from "../lenses/export.js"
import type { HarnessRunner } from "../runner.js"
import { findAgentLeads, parseFoundLeads, shortenForReader, splitIntoPieces } from "./finder.js"

const rec = (seq: number, fields: Partial<SessionExportRecord> = {}): SessionExportRecord => ({
  seq,
  id: `msg-${seq}`,
  msgType: "message",
  role: "assistant",
  track: "main",
  ts: seq * 1000,
  text: `text ${seq}`,
  ...fields,
})

describe("splitIntoPieces", () => {
  test("FP1: the main track is cut into slices under the size budget, each helper is its own piece", () => {
    const records = [
      rec(0),
      rec(1, { track: "agent:a" }),
      rec(2, { text: "x".repeat(300) }),
      rec(3, { track: "agent:a" }),
      rec(4, { text: "y".repeat(300) }),
    ]
    const pieces = splitIntoPieces(records, 500)
    expect(pieces.map((piece) => [piece.label, piece.records.map((r) => r.seq)])).toEqual([
      ["main, part 1", [0, 2]],
      ["helper agent:a", [1, 3]],
      ["main, part 2", [4]],
    ])
  })

  test("FP2: one record bigger than the budget still gets a piece of its own", () => {
    const pieces = splitIntoPieces([rec(0, { text: "z".repeat(900) }), rec(1)], 500)
    expect(pieces.map((piece) => piece.records.map((r) => r.seq))).toEqual([[0], [1]])
  })
})

describe("shortenForReader", () => {
  const long = (middle: string): string => `${"a".repeat(1500)}\n${middle}\n${"z".repeat(1500)}`
  const call = (seq: number, toolName: string, status: string, output: string) =>
    rec(seq, { msgType: "toolCall", toolName, status, output })

  test("FS1: a record with no output, and a short failed output, are left as they are", () => {
    const short = call(0, "Bash", "failure", "exit 1")
    expect(shortenForReader(short)).toBe(short)
    expect(shortenForReader(rec(1))).toEqual(rec(1))
  })

  test("FS2: a long failed output keeps its start and end, and says how much was cut", () => {
    const output = shortenForReader(call(0, "Bash", "failure", long("m".repeat(5000)))).output ?? ""
    expect(output.startsWith("a".repeat(1000))).toBe(true)
    expect(output.endsWith("z".repeat(1000))).toBe(true)
    expect(output).toMatch(/\[… \d[\d,]* characters cut/)
    expect(output.length).toBeLessThan(2400)
  })

  test("FS3: a call that worked loses its output, except lines that mention an error, warning or secret", () => {
    const middle = `${"m".repeat(2000)}\nWARNING: token xoxb-123 in env\n${"m".repeat(2000)}`
    for (const [toolName, status] of [
      ["Bash", "success"],
      ["Read", "unknown"],
    ] as const) {
      const output = shortenForReader(call(0, toolName, status, long(middle))).output ?? ""
      expect(output).toContain("WARNING: token xoxb-123 in env")
      expect(output).not.toContain("aaaa")
      expect(output).toMatch(/output left out/)
    }
    expect(shortenForReader(call(1, "Bash", "success", "ok")).output).toMatch(/output left out/)
  })

  test("FS3b: the person's answer to a question is kept whole, even when the call worked", () => {
    const answer = call(0, "AskUserQuestion", "success", long("m".repeat(5000)))
    expect(shortenForReader(answer)).toBe(answer)
  })
})

describe("shortenForReader inputs", () => {
  test("FS4: a big tool input, like a whole file written, is shortened too; one just over the edges is not", () => {
    const write = rec(0, { msgType: "toolCall", toolName: "Write", input: "w".repeat(10_000) })
    expect(shortenForReader(write).input?.length).toBeLessThan(2200)
    const near = rec(1, {
      msgType: "toolCall",
      toolName: "Bash",
      status: "failure",
      output: "o".repeat(2100),
    })
    expect(shortenForReader(near)).toBe(near)
  })
})

describe("parseFoundLeads", () => {
  test("FL1: each line is ids, the exact words, and why it may be a problem", () => {
    expect(
      parseFoundLeads(
        '# Leads\n\n- msg-3 to msg-5 — "all tests pass" — said before any test ran\n- msg-9 — "xoxb-123" — a secret in the output\nnot a lead\n',
      ),
    ).toEqual([
      { from: "msg-3", to: "msg-5", quote: "all tests pass", why: "said before any test ran" },
      { from: "msg-9", to: "msg-9", quote: "xoxb-123", why: "a secret in the output" },
    ])
  })
})

describe("findAgentLeads", () => {
  const exported: SessionExport = {
    meta: { sessionId: "s", title: "t", source: "claude_code" },
    records: [
      rec(0, { role: "user", text: "fix the build" }),
      rec(1, { text: "all tests pass" }),
      rec(2, { track: "agent:a", text: "helper did the work" }),
    ],
    index: {
      seqs: [0, 1, 2],
      messageIds: ["msg-0", "msg-1", "msg-2"],
      tracks: ["main", "agent:a"],
    },
  }

  /** A reader that writes whatever `write` returns for its piece. */
  const reader = (write: (piece: string, instructions: string) => string | undefined) => {
    const seen: string[] = []
    const runner: HarnessRunner = {
      run: async ({ workspaceDir, prompt }) => {
        const piece = readFileSync(join(workspaceDir, "piece.json"), "utf8")
        seen.push(prompt)
        const out = write(piece, readFileSync(join(workspaceDir, "INSTRUCTIONS.md"), "utf8"))
        if (out !== undefined) writeFileSync(join(workspaceDir, "leads.md"), out)
        return { stdout: "done", firstByteMs: 1 }
      },
    }
    return { runner, seen }
  }

  test("FA1: every piece is read by its own run, and the leads that hold come back with their piece", async () => {
    const { runner, seen } = reader((piece) =>
      piece.includes("all tests pass")
        ? '- msg-1 — "all tests pass" — nothing was run before this'
        : '- msg-2 — "helper did the work" — says done without showing it',
    )
    const result = await findAgentLeads({ exported, instructions: "# How to review", runner })
    expect(seen).toHaveLength(2)
    expect(result.pieceCount).toBe(2)
    expect(result.leads).toEqual([
      {
        from: "msg-1",
        to: "msg-1",
        quote: "all tests pass",
        why: "nothing was run before this",
        piece: "main, part 1",
      },
      {
        from: "msg-2",
        to: "msg-2",
        quote: "helper did the work",
        why: "says done without showing it",
        piece: "helper agent:a",
      },
    ])
    expect(result.dropped).toEqual([])
    expect(result.failedPieces).toEqual([])
  })

  test("FA2: a lead quoting what is not there is dropped; a reader that writes nothing is a failed piece, not a failed review", async () => {
    const { runner } = reader((piece) =>
      piece.includes("all tests pass") ? '- msg-1 — "tests are green" — invented' : undefined,
    )
    const result = await findAgentLeads({ exported, instructions: "# How to review", runner })
    expect(result.leads).toEqual([])
    expect(result.dropped).toEqual(['main, part 1: "tests are green" is not in msg-1'])
    expect(result.failedPieces).toEqual(["helper agent:a: wrote no leads.md"])
  })

  test("FA3: readers get the review's instructions, so a user's own rules shape what they look for", async () => {
    let instructions = ""
    const { runner } = reader((_, given) => {
      instructions = given
      return "Nothing found."
    })
    await findAgentLeads({
      exported,
      instructions: "# How to review\n\nEvery port change is a problem.",
      runner,
    })
    expect(instructions).toContain("Every port change is a problem.")
  })

  test("FA4: a reader's lead may point at a wide range and explain at length; only the words must be there", async () => {
    const many: SessionExport = {
      ...exported,
      records: Array.from({ length: 80 }, (_, seq) =>
        rec(seq, { text: seq === 70 ? "the build is fixed" : `step ${seq}` }),
      ),
    }
    const { runner } = reader(
      () => `- msg-0 to msg-79 — "the build is fixed" — ${"a long reason ".repeat(40)}`,
    )
    const result = await findAgentLeads({ exported: many, instructions: "# How to review", runner })
    expect(result.dropped).toEqual([])
    expect(result.leads).toHaveLength(1)
  })

  test("FA5: a reader gets long outputs shortened, and a quote from what it was shown still holds", async () => {
    const output = `${"a".repeat(1500)}\n${"m".repeat(9000)}\nError: build failed\n${"z".repeat(1500)}`
    const big: SessionExport = {
      ...exported,
      records: [rec(0, { msgType: "toolCall", toolName: "Bash", output })],
    }
    let shown = ""
    const { runner } = reader((piece) => {
      shown = piece
      return '- msg-0 — "Error: build failed" — the build failed and was not reported'
    })
    const result = await findAgentLeads({ exported: big, instructions: "# How to review", runner })
    expect(shown).not.toContain("m".repeat(9000))
    expect(result.dropped).toEqual([])
    expect(result.leads).toHaveLength(1)
  })
})
