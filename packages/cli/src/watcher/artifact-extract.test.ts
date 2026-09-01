import { join } from "node:path"
import {
  type NormalizedMessage,
  normalizeClaude,
  normalizeOpencode,
  type ParsedRecord,
} from "@samskara/core"
import { describe, expect, test } from "vitest"
import {
  collectArtifacts,
  mergeArtifact,
  type PotentialArtifact,
  referencedPaths,
} from "./artifact-extract.js"

const CWD = "/work/app"

const base = {
  sessionId: "sess-1",
  source: "claude_code" as const,
  sourceSchemaVersion: 1,
  trackId: "main",
}

const recordOf = (
  messages: readonly [NormalizedMessage, ...NormalizedMessage[]],
  lineUuid = "call-1",
  lineNumber = 1,
): ParsedRecord => ({ lineUuid, lineNumber, raw: {}, messages })

type WriteOptions = {
  readonly created?: boolean
  readonly base?: string
  readonly timestamp?: string
}

/** A toolResult carrying a `wrote` effect -- what either plugin emits for a completed write. */
const wrote = (path: string, over: WriteOptions = {}): NormalizedMessage => ({
  ...base,
  subIndex: 0,
  timestamp: over.timestamp ?? "2026-07-28T12:00:00.000Z",
  msgType: "toolResult",
  details: {
    callId: "c1",
    output: "ok",
    status: "success",
    metadata: {
      type: "wrote",
      path,
      created: over.created ?? false,
      ...(over.base === undefined ? {} : { base: over.base }),
    },
  },
})

const humanEdit = (path: string, timestamp = "2026-07-28T12:01:00.000Z"): NormalizedMessage => ({
  ...base,
  subIndex: 0,
  timestamp,
  msgType: "fileEvent",
  details: { type: "edited", path },
})

const writeLine = (path: string, over: WriteOptions = {}) => recordOf([wrote(path, over)])
const LATER = "2026-07-28T12:01:00.000Z"

describe("collectArtifacts", () => {
  test("SC1: a written file is captured by its absolute path", () => {
    const [artifact] = collectArtifacts([writeLine("src/a.ts")], CWD)

    expect(artifact?.path).toBe("/work/app/src/a.ts")
    expect(artifact?.created).toBe(false)
  })

  test("SC2: a file written twice is one artifact, not two", () => {
    const first = recordOf([wrote("src/a.ts")], "call-1", 1)
    const second = recordOf([wrote("src/a.ts", { timestamp: LATER })], "call-2", 2)

    expect(collectArtifacts([first, second], CWD)).toHaveLength(1)
  })

  test("SC3: the first pre-session content seen becomes the base", () => {
    const first = recordOf([wrote("src/a.ts", { base: "first content" })], "call-1", 1)
    const second = recordOf(
      [wrote("src/a.ts", { base: "second content", timestamp: LATER })],
      "call-2",
      2,
    )

    const [artifact] = collectArtifacts([first, second], CWD)
    expect(artifact?.base).toBe("first content")
    expect(artifact?.created).toBe(false)
  })

  test("SC3b: writes from two transcripts of one session settle the base by time, not by line", () => {
    const main = recordOf([wrote("src/a.ts", { base: "earliest content" })], "main-call", 500)
    const subagent = recordOf(
      [wrote("src/a.ts", { base: "later content", timestamp: LATER })],
      "sub-call",
      3,
    )

    // Passed sub-before-main, to prove the sort is on timestamp rather than array or line order.
    const [artifact] = collectArtifacts([subagent, main], CWD)
    expect(artifact?.base).toBe("earliest content")
  })

  test("SC4: a write recorded without pre-session content yields no base", () => {
    const [artifact] = collectArtifacts([writeLine("src/a.ts")], CWD)
    expect(artifact?.base).toBeUndefined()
    expect(artifact?.created).toBe(false)
  })

  test("SC5: a file the session created never takes a base", () => {
    const create = recordOf([wrote("src/a.ts", { created: true })], "call-1", 1)
    const edit = recordOf(
      [wrote("src/a.ts", { base: "pre-session content", timestamp: LATER })],
      "call-2",
      2,
    )

    const [artifact] = collectArtifacts([create, edit], CWD)
    expect(artifact?.created).toBe(true)
    expect(artifact?.base).toBeUndefined()
  })

  test("SC6: overwriting an existing file is not creating it", () => {
    const [artifact] = collectArtifacts([writeLine("src/a.ts", { base: "existing content" })], CWD)
    expect(artifact?.created).toBe(false)
    expect(artifact?.base).toBe("existing content")
  })

  test("SC7: a file the human edited is captured with nothing but its path", () => {
    const [artifact] = collectArtifacts([recordOf([humanEdit("docs/a.md")])], CWD)
    expect(artifact?.path).toBe("/work/app/docs/a.md")
    expect(artifact?.base).toBeUndefined()
    expect(artifact?.created).toBe(false)
  })

  test("SC8: a human edit never erases the base a write recorded", () => {
    const write = recordOf([wrote("docs/a.md", { base: "base content" })], "call-1", 1)
    const human = recordOf([humanEdit("docs/a.md")], "call-2", 2)

    const [artifact] = collectArtifacts([write, human], CWD)
    expect(artifact?.base).toBe("base content")
  })

  test("SC10: messages that are not write effects are ignored, whatever the raw line held", () => {
    const shellResult: NormalizedMessage = {
      ...base,
      subIndex: 0,
      msgType: "toolResult",
      details: { callId: "c2", output: "plain string output", status: "success" },
    }
    const call: NormalizedMessage = {
      ...base,
      subIndex: 0,
      msgType: "toolCall",
      details: { callId: "c3", name: "Bash", input: { command: "ls" } },
    }
    const records = [
      recordOf([shellResult], "r1", 1),
      recordOf([call], "r2", 2),
      { ...recordOf([call], "r3", 3), raw: { toolUseResult: { filePath: "src/x.ts" } } },
    ]

    expect(collectArtifacts(records, CWD)).toEqual([])
  })

  test("an OpenCode write and a Claude Write yield the same artifact", () => {
    const claude = normalizeClaude(
      {
        type: "user",
        timestamp: "2026-07-28T12:00:00.000Z",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }],
        },
        toolUseResult: { type: "create", filePath: "src/new.ts", content: "x" },
      },
      { sessionId: "sess-1", trackId: "main", lineNumber: 1 },
    )
    const opencode = normalizeOpencode(
      {
        id: "msg_1",
        timeCreated: Date.parse("2026-07-28T12:00:00.000Z"),
        data: { role: "assistant" },
      },
      [
        {
          id: "part_1",
          timeCreated: Date.parse("2026-07-28T12:00:00.000Z"),
          data: {
            type: "tool",
            tool: "write",
            callID: "c1",
            state: { status: "completed", input: { filePath: "src/new.ts", content: "x" } },
          },
        },
      ],
      { sessionId: "sess-1", trackId: "main" },
    )
    const [first, ...rest] = opencode
    if (!first) throw new Error("opencode produced no messages")

    const fromClaude = collectArtifacts([recordOf(claude)], CWD)
    const fromOpencode = collectArtifacts([recordOf([first, ...rest])], CWD)
    expect(fromClaude).toEqual([{ path: "/work/app/src/new.ts", created: true }])
    expect(fromOpencode).toEqual(fromClaude)
  })
})

describe("mergeArtifact", () => {
  test("SC11: the earlier view's base survives the fold", () => {
    const a: PotentialArtifact = { path: "/x", created: false, base: "content1" }
    const b: PotentialArtifact = { path: "/x", created: false, base: "content2" }

    expect(mergeArtifact(a, b).base).toBe("content1")
  })

  test("SC11: a later view's base fills a gap the earlier one left", () => {
    const a: PotentialArtifact = { path: "/x", created: false }
    const b: PotentialArtifact = { path: "/x", created: false, base: "content2" }

    expect(mergeArtifact(a, b).base).toBe("content2")
  })

  test("SC11: the result is created when either view is", () => {
    const created: PotentialArtifact = { path: "/x", created: true }
    const notCreated: PotentialArtifact = { path: "/x", created: false }

    expect(mergeArtifact(created, notCreated).created).toBe(true)
    expect(mergeArtifact(notCreated, created).created).toBe(true)
  })

  test("SC12: a created file drops a base a later view carries", () => {
    const created: PotentialArtifact = { path: "/x", created: true }
    const withBase: PotentialArtifact = { path: "/x", created: false, base: "session-written" }

    expect(mergeArtifact(created, withBase).base).toBeUndefined()
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
