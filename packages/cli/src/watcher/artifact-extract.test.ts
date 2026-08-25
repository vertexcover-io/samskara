import { join } from "node:path"
import type { NormalizedMessage, ParsedRecord } from "@samskara/core"
import { createLogger } from "@samskara/core"
import { describe, expect, test } from "vitest"
import { collectArtifacts, type PotentialArtifact, referencedPaths } from "./artifact-extract.js"

const CWD = "/work/app"

const log = createLogger({ service: "samskara-cli-test" }, { level: "silent" })

const message = (over: Partial<NormalizedMessage> & { readonly subIndex: number }) =>
  ({
    sessionId: "sess-1",
    source: "claude_code",
    sourceSchemaVersion: 1,
    trackId: "main",
    ...over,
  }) as NormalizedMessage

const toolCall = (subIndex: number, name: string, input: unknown): NormalizedMessage =>
  message({ subIndex, msgType: "toolCall", details: { callId: `c${subIndex}`, name, input } })

const delta = (subIndex: number, path: string, backup: unknown): NormalizedMessage =>
  message({ subIndex, msgType: "fileEvent", details: { type: "delta", path, backup } })

const recordOf = (messages: ReadonlyArray<NormalizedMessage>): ParsedRecord => {
  const [first, ...rest] = messages
  if (!first) throw new Error("a record needs at least one message")
  return {
    lineUuid: "0191d942-3ba5-7dba-9a7d-22d65b30258c",
    lineNumber: 1,
    raw: {},
    messages: [first, ...rest],
  }
}

const collect = (messages: ReadonlyArray<NormalizedMessage>): ReadonlyArray<PotentialArtifact> =>
  collectArtifacts([recordOf(messages)], CWD, log)

const byPath = (candidates: ReadonlyArray<PotentialArtifact>, path: string) =>
  candidates.find((candidate) => candidate.path === path)

describe("collectArtifacts", () => {
  // Driving the write-family from a table means adding a tool here without adding it to the
  // projection fails, rather than silently going uncaptured.
  const writeFamily = [
    { name: "Write", input: { file_path: "src/a.ts" }, path: "/work/app/src/a.ts" },
    { name: "Edit", input: { file_path: "src/b.ts" }, path: "/work/app/src/b.ts" },
    { name: "MultiEdit", input: { file_path: "src/c.ts" }, path: "/work/app/src/c.ts" },
    {
      name: "NotebookEdit",
      input: { notebook_path: "src/d.ipynb" },
      path: "/work/app/src/d.ipynb",
    },
  ] as const

  test("S1: every write-family tool call yields a candidate at its absolute path", () => {
    const candidates = collect(
      writeFamily.map((tool, index) => toolCall(index, tool.name, tool.input)),
    )

    expect(candidates.map((candidate) => candidate.path).sort()).toEqual(
      writeFamily.map((tool) => tool.path).sort(),
    )
  })

  test("S1: a Read tool call yields no candidate", () => {
    expect(collect([toolCall(0, "Read", { file_path: "src/a.ts" })])).toEqual([])
  })

  test("S1: Write is created and the edit family is edited", () => {
    const candidates = collect(
      writeFamily.map((tool, index) => toolCall(index, tool.name, tool.input)),
    )

    expect(byPath(candidates, "/work/app/src/a.ts")?.changeKind).toBe("created")
    expect(byPath(candidates, "/work/app/src/b.ts")?.changeKind).toBe("edited")
    expect(byPath(candidates, "/work/app/src/c.ts")?.changeKind).toBe("edited")
    expect(byPath(candidates, "/work/app/src/d.ipynb")?.changeKind).toBe("edited")
  })

  test("S1: an already-absolute path is kept rather than re-resolved against cwd", () => {
    const candidates = collect([toolCall(0, "Write", { file_path: "/elsewhere/x.ts" })])

    expect(candidates.map((candidate) => candidate.path)).toEqual(["/elsewhere/x.ts"])
  })

  test("S2: a MultiEdit naming three files yields three candidates", () => {
    const candidates = collect([
      toolCall(0, "MultiEdit", { file_path: "src/one.ts", edits: [{ old_string: "a" }] }),
      toolCall(1, "MultiEdit", { file_path: "src/two.ts", edits: [{ old_string: "b" }] }),
      toolCall(2, "MultiEdit", { file_path: "src/three.ts" }),
    ])

    expect(candidates.map((candidate) => candidate.path).sort()).toEqual([
      "/work/app/src/one.ts",
      "/work/app/src/three.ts",
      "/work/app/src/two.ts",
    ])
  })

  test("S2: a MultiEdit's several edits to one file collapse to a single candidate", () => {
    const candidates = collect([
      toolCall(0, "MultiEdit", {
        file_path: "src/one.ts",
        edits: [{ old_string: "first" }, { old_string: "second" }],
      }),
    ])

    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.oldFragment).toBe("second")
  })

  test("S3: a delta alone supplies no candidate", () => {
    const candidates = collect([delta(0, "docs/a.md", { backupFileName: "3c32b39a@v1" })])

    expect(candidates).toEqual([])
  })

  test("S3: a delta alongside an Edit contributes its backup pointer", () => {
    const candidates = collect([
      toolCall(0, "Edit", { file_path: "docs/a.md" }),
      delta(1, "docs/a.md", { backupFileName: "3c32b39a@v1" }),
    ])

    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.backupFileName).toBe("3c32b39a@v1")
  })

  test("S4: a delta whose backupFileName is null leaves the candidate without a pointer", () => {
    const candidates = collect([
      toolCall(0, "Edit", { file_path: "docs/a.md" }),
      delta(1, "docs/a.md", { backupFileName: null }),
    ])

    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.backupFileName).toBeUndefined()
    // The cycle cannot decide `editedUnknownBase` -- resolving a base needs a disk read.
    expect(candidates[0]?.changeKind).toBe("edited")
  })

  test("S5: a malformed tool input is skipped without dropping its record's other messages", () => {
    const candidates = collect([
      toolCall(0, "Write", { file_path: 42 }),
      toolCall(1, "Edit", { file_path: "src/ok.ts" }),
    ])

    expect(candidates.map((candidate) => candidate.path)).toEqual(["/work/app/src/ok.ts"])
  })

  test("captures an Edit's old_string as the fragment", () => {
    const candidates = collect([
      toolCall(0, "Edit", { file_path: "src/a.ts", old_string: "before" }),
    ])

    expect(candidates[0]?.oldFragment).toBe("before")
  })

  test("dedupes repeated writes to one path, with the last write winning", () => {
    const candidates = collect([
      toolCall(0, "Edit", { file_path: "src/a.ts", old_string: "first" }),
      toolCall(1, "Edit", { file_path: "src/a.ts", old_string: "second" }),
    ])

    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.oldFragment).toBe("second")
  })

  test("a fileEvent of type edited yields a candidate", () => {
    const candidates = collect([
      message({
        subIndex: 0,
        msgType: "fileEvent",
        details: { type: "edited", path: "docs/a.md" },
      }),
    ])

    expect(candidates.map((candidate) => candidate.path)).toEqual(["/work/app/docs/a.md"])
  })
})

describe("referencedPaths", () => {
  const FROM_DIR = "/work/app/docs"

  test("S2: markdown images and links are both extracted, and a title suffix is dropped", () => {
    const content = '![shot](img/a.png) and [clip](vid/b.mp4) and [c](vid/c.mp4 "caption")'

    expect(referencedPaths(content, FROM_DIR)).toEqual([
      join(FROM_DIR, "img/a.png"),
      join(FROM_DIR, "vid/b.mp4"),
      join(FROM_DIR, "vid/c.mp4"),
    ])
  })

  test("S3: remote and non-file references are ignored", () => {
    const content = [
      '<img src="https://example.com/a.png">',
      '<a href="http://x/y">',
      '<a href="data:image/png;base64,AAA">',
      '<a href="mailto:a@b.c">',
      '<script src="//cdn.example.com/z.js">',
      '<a href="#section">',
    ].join("\n")

    expect(referencedPaths(content, FROM_DIR)).toEqual([])
  })

  test("S4: query strings and fragments are stripped before resolving", () => {
    const content = '<video src="clips/run.mp4?t=3#frag"><img src="img/a.png#top">'

    expect(referencedPaths(content, FROM_DIR)).toEqual([
      join(FROM_DIR, "clips/run.mp4"),
      join(FROM_DIR, "img/a.png"),
    ])
  })

  test("S5: references resolve against the document's own directory, not the project root", () => {
    const content = '<img src="../assets/a.png">'

    expect(referencedPaths(content, "/work/app/docs/deep")).toEqual([
      join("/work/app/docs", "assets/a.png"),
    ])
  })

  test("S6: a percent-encoded filename decodes before resolving", () => {
    const content = '<img src="shots/01%20login.png">'

    expect(referencedPaths(content, FROM_DIR)).toEqual([join(FROM_DIR, "shots/01 login.png")])
  })

  test("S8: reference-style markdown links and autolinks are not extracted", () => {
    const content = "[shot][ref]\n\n[ref]: img/a.png\n\n<./b.mp4>"

    expect(referencedPaths(content, FROM_DIR)).toEqual([])
  })

  test("dedupes by resolved path, keeping first-appearance order", () => {
    const content = '<img src="img/a.png"><a href="img/a.png">[again](img/a.png)'

    expect(referencedPaths(content, FROM_DIR)).toEqual([join(FROM_DIR, "img/a.png")])
  })

  test("html src, href, and poster attributes are all extracted", () => {
    const content = '<video src="v.mp4" poster="p.png"><a href="l.pdf">'

    expect(referencedPaths(content, FROM_DIR)).toEqual([
      join(FROM_DIR, "v.mp4"),
      join(FROM_DIR, "p.png"),
      join(FROM_DIR, "l.pdf"),
    ])
  })

  test("a markdown destination with balanced parentheses is not truncated", () => {
    const content = "[shot](image(1).png)"

    expect(referencedPaths(content, FROM_DIR)).toEqual([join(FROM_DIR, "image(1).png")])
  })

  test("attributes that merely end in src/href/poster are not extracted", () => {
    const content = [
      '<img data-src="thumb.jpg">',
      '<a data-href="foo.html">',
      '<svg><use xlink:href="icons.svg#a"></svg>',
      '<video data-poster="p.jpg">',
    ].join("\n")

    expect(referencedPaths(content, FROM_DIR)).toEqual([])
  })

  test("a malformed percent-encoded reference falls back to the raw string rather than throwing", () => {
    const content = '<img src="shots/bad%zzname.png">'

    expect(() => referencedPaths(content, FROM_DIR)).not.toThrow()
    expect(referencedPaths(content, FROM_DIR)).toEqual([join(FROM_DIR, "shots/bad%zzname.png")])
  })
})
