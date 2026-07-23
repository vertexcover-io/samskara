import { mkdtempSync } from "node:fs"
import { mkdtemp, readFile, rename, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import { compact, iterJsonLines, readNewLines } from "./helpers.js"
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

const tempDir = () => mkdtemp(join(tmpdir(), "samskara-helpers-"))

const checkpoint = (lineProcessed: number): Checkpoint => ({
  filePath: "/a.jsonl",
  lastUpdatedAt: "2026-07-24T00:00:00.000Z",
  source: "claude_code",
  mtime: 0,
  size: 0,
  lineProcessed,
})

describe("readNewLines", () => {
  test("returns only lines beyond the watermark and advances it", async () => {
    const dir = await tempDir()
    const path = join(dir, "a.jsonl")
    await writeFile(path, "one\ntwo\nthree\n", "utf8")

    const result = await readNewLines(nodeFs, path, 1)
    expect(result.lines).toEqual([
      { lineNumber: 2, text: "two" },
      { lineNumber: 3, text: "three" },
    ])
    expect(result.lastLineProcessed).toBe(3)
  })

  test("same content yields no new lines", async () => {
    const dir = await tempDir()
    const path = join(dir, "b.jsonl")
    await writeFile(path, "one\ntwo\n", "utf8")
    const result = await readNewLines(nodeFs, path, 2)
    expect(result.lines).toEqual([])
    expect(result.lastLineProcessed).toBe(2)
  })

  test("torn trailing line is not emitted until completed", async () => {
    const dir = await tempDir()
    const path = join(dir, "c.jsonl")
    await writeFile(path, "one\ntwo\npar", "utf8")

    const torn = await readNewLines(nodeFs, path, 0)
    expect(torn.lines.map((l) => l.text)).toEqual(["one", "two"])
    expect(torn.lastLineProcessed).toBe(2)

    await writeFile(path, "one\ntwo\npartial\n", "utf8")
    const healed = await readNewLines(nodeFs, path, torn.lastLineProcessed)
    expect(healed.lines).toEqual([{ lineNumber: 3, text: "partial" }])
  })
})

describe("iterJsonLines", () => {
  test("skips blank and malformed lines, keeps line numbers", () => {
    const parsed = iterJsonLines([
      { lineNumber: 1, text: '{"a":1}' },
      { lineNumber: 2, text: "   " },
      { lineNumber: 3, text: "not json" },
      { lineNumber: 4, text: '{"b":2}' },
    ])
    expect(parsed).toEqual([
      { lineNumber: 1, data: { a: 1 } },
      { lineNumber: 4, data: { b: 2 } },
    ])
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
    expect(roundTripped.checkpoints["/a.jsonl"]?.lineProcessed).toBe(5)
  })

  test("missing state file yields empty", async () => {
    const dir = mkdtempSync(join(tmpdir(), "samskara-state-"))
    const missing = await readCheckpoints(nodeFs, join(dir, "nope.json"))
    expect(missing).toEqual({ checkpoints: {} })
  })

  test("a malformed checkpoint entry falls back to empty", async () => {
    const dir = mkdtempSync(join(tmpdir(), "samskara-state-"))
    const path = join(dir, "state.json")
    await writeFile(
      path,
      JSON.stringify({ checkpoints: { "/a.jsonl": { garbage: true } } }),
      "utf8",
    )
    expect(await readCheckpoints(nodeFs, path)).toEqual({ checkpoints: {} })
  })
})
