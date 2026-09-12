import { mkdtempSync } from "node:fs"
import { readFile, rename, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { compact, completeLines, parseJsonLines } from "./helpers.js"
import { readCheckpoints, writeCheckpoints } from "./state.js"
import type { Checkpoint } from "./types.js"

const nodeFs = {
  readFile: (path: string) => readFile(path, "utf8"),
  writeFile: (path: string, data: string) => writeFile(path, data, "utf8"),
  rename,
  stat: async (path: string) => {
    const s = await stat(path)
    return { size: s.size, mtimeMs: s.mtimeMs }
  },
}

const checkpoint = (lineProcessed: number): Checkpoint => ({
  filePath: "/a.jsonl",
  lastUpdatedAt: "2026-07-24T00:00:00.000Z",
  source: "claude_code",
  mtime: 0,
  size: 0,
  lineProcessed,
})

describe("completeLines", () => {
  test("numbers every complete line and drops the torn trailing line", () => {
    expect(completeLines("one\ntwo\nthree\n")).toEqual([
      { lineNumber: 1, text: "one" },
      { lineNumber: 2, text: "two" },
      { lineNumber: 3, text: "three" },
    ])
    expect(completeLines("one\ntwo\npar")).toEqual([
      { lineNumber: 1, text: "one" },
      { lineNumber: 2, text: "two" },
    ])
  })
})

describe("parseJsonLines", () => {
  test("S5: blank lines are skipped and objects keep their line numbers", () => {
    expect(
      parseJsonLines([
        { lineNumber: 1, text: '{"a":1}' },
        { lineNumber: 2, text: "   " },
        { lineNumber: 3, text: '{"b":2}' },
      ]),
    ).toEqual([
      { lineNumber: 1, data: { a: 1 } },
      { lineNumber: 3, data: { b: 2 } },
    ])
  })

  test("S5: malformed and non-object lines throw", () => {
    expect(() => parseJsonLines([{ lineNumber: 3, text: "not json" }])).toThrow()
    expect(() => parseJsonLines([{ lineNumber: 4, text: "false" }])).toThrow(/Line 4/)
  })
})

test("compact removes null and undefined", () => {
  expect(compact([1, null, 2, undefined, 3])).toEqual([1, 2, 3])
})

describe("checkpoints", () => {
  test("write is atomic via temp then rename, and round-trips", async () => {
    const dir = mkdtempSync(join(tmpdir(), "samskara-state-"))
    const path = join(dir, "state.json")
    const store = { checkpoints: { "/a.jsonl": checkpoint(5) } }

    await writeCheckpoints(nodeFs, path, store)
    const roundTripped = await readCheckpoints(nodeFs, path)
    expect(roundTripped.checkpoints["/a.jsonl"]).toMatchObject({ lineProcessed: 5 })
  })

  test("missing state file yields empty", async () => {
    const dir = mkdtempSync(join(tmpdir(), "samskara-state-"))
    const missing = await readCheckpoints(nodeFs, join(dir, "nope.json"))
    expect(missing).toEqual({ checkpoints: {} })
  })

  test("a malformed checkpoint entry throws rather than resyncing everything silently", async () => {
    const dir = mkdtempSync(join(tmpdir(), "samskara-state-"))
    const path = join(dir, "state.json")
    await writeFile(
      path,
      JSON.stringify({ checkpoints: { "/a.jsonl": { garbage: true } } }),
      "utf8",
    )
    await expect(readCheckpoints(nodeFs, path)).rejects.toThrow()
  })
})
