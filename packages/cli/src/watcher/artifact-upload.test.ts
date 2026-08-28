import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"

import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import type { ArtifactQueueEntry } from "./artifact-queue.js"
import { classifyContentType, prepareUpload } from "./artifact-upload.js"
import { silentLogger, spyLogger } from "./test-logger.js"

let root = ""

const SESSION = "sess-artifact"

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "samskara-artifact-"))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const projectFile = async (relativePath: string, content: string | Buffer): Promise<string> => {
  const path = join(root, relativePath)
  await mkdir(join(path, ".."), { recursive: true })
  await writeFile(path, content)
  return path
}

const entryFor = (
  over: Partial<ArtifactQueueEntry> & { readonly path: string },
): ArtifactQueueEntry => ({
  sessionId: SESSION,
  relativePath: "docs/notes.md",
  projectRoot: "/work/app",
  created: false,
  observedAt: "2026-07-28T10:00:00.000Z",
  attempts: 0,
  ...over,
})

const deps = (log = silentLogger()) => ({ log })

const ORIGINAL = "# Notes\n\nOriginal line.\nShared tail.\n"
const CHANGED = "# Notes\n\nChanged line.\nShared tail.\n"

/**
 * Long lines rather than many lines: the diff's cost grows with the line count, its size with
 * line length. This clears the 1 MB cap in milliseconds where 30k short lines takes minutes.
 */
const wideText = (marker: string): string =>
  Array.from({ length: 200 }, (_, i) => `${marker}${i}-${marker.repeat(3000)}`).join("\n")

describe("prepareUpload", () => {
  test("an edited file with a base yields baseContent and changeKind 'edited'", async () => {
    const path = await projectFile("docs/notes.md", CHANGED)

    const upload = await prepareUpload(deps(), entryFor({ path, base: ORIGINAL }))

    expect(upload?.changeKind).toBe("edited")
    expect(upload?.baseContent).toBe(ORIGINAL)
    expect(upload?.currentContent).toBe(CHANGED)
  })

  test("SC33: a base that is the empty string yields changeKind 'edited', not 'editedUnknownBase'", async () => {
    const path = await projectFile("docs/notes.md", CHANGED)

    const upload = await prepareUpload(deps(), entryFor({ path, base: "" }))

    expect(upload?.changeKind).toBe("edited")
    expect(upload?.baseContent).toBe("")
  })

  test("a change with no base yields editedUnknownBase, and still carries the current content", async () => {
    const path = await projectFile("docs/notes.md", CHANGED)

    const upload = await prepareUpload(deps(), entryFor({ path }))

    expect(upload?.changeKind).toBe("editedUnknownBase")
    expect(upload?.baseContent).toBeUndefined()
    expect(upload?.currentContent).toBe(CHANGED)
  })

  test("created is tested first: changeKind stays 'created' even if the entry also carries a base", async () => {
    const path = await projectFile("docs/new.md", CHANGED)

    const upload = await prepareUpload(
      deps(),
      entryFor({ path, created: true, base: "content the session itself wrote" }),
    )

    expect(upload?.changeKind).toBe("created")
    expect(upload?.currentContent).toBe(CHANGED)
  })

  test("a created entry with no base at all also reports changeKind 'created'", async () => {
    const path = await projectFile("docs/new.md", CHANGED)

    const upload = await prepareUpload(deps(), entryFor({ path, created: true }))

    expect(upload?.changeKind).toBe("created")
    expect(upload?.baseContent).toBeUndefined()
  })

  test("a file written then deleted is skipped and logged at debug", async () => {
    const recorder = spyLogger()

    const upload = await prepareUpload(
      { log: recorder.log },
      entryFor({ path: join(root, "docs/vanished.md") }),
    )

    expect(upload).toBeNull()
    expect(recorder.debug.length).toBeGreaterThan(0)
    expect(recorder.warn).toHaveLength(0)
  })
})

describe("prepareUpload — binary and encoding", () => {
  const PNG = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  ])

  test("a binary file is captured whole, base64-encoded, with no base", async () => {
    const path = await projectFile("assets/logo.png", PNG)

    const upload = await prepareUpload(deps(), entryFor({ path, relativePath: "assets/logo.png" }))

    expect(upload?.encoding).toBe("base64")
    expect(upload?.baseContent).toBeUndefined()
    expect(Buffer.from(upload?.currentContent ?? "", "base64")).toEqual(PNG)
  })

  test("a utf8 text file with a base is utf8-encoded and carries it through", async () => {
    const path = await projectFile("docs/notes.md", CHANGED)

    const upload = await prepareUpload(deps(), entryFor({ path, base: ORIGINAL }))

    expect(upload?.encoding).toBe("utf8")
    expect(upload?.baseContent).toBe(ORIGINAL)
  })
})

describe("prepareUpload — size caps", () => {
  test("S22: a text file over 5 MB is skipped with a warn naming path and size", async () => {
    const oversize = "a".repeat(5 * 1024 * 1024 + 1)
    const path = await projectFile("docs/huge.md", oversize)
    const recorder = spyLogger()

    const upload = await prepareUpload({ log: recorder.log }, entryFor({ path }))

    expect(upload).toBeNull()
    const warned = recorder.warn[0]
    expect(warned).toBeDefined()
    expect(JSON.stringify(warned?.details)).toContain(path)
    expect(JSON.stringify(warned?.details)).toContain(String(oversize.length))
  })

  test("S22: a binary file over 50 MB is skipped", async () => {
    const oversize = Buffer.alloc(50 * 1024 * 1024 + 1)
    const path = await projectFile("assets/huge.bin", oversize)

    const upload = await prepareUpload(deps(), entryFor({ path, created: true }))

    expect(upload).toBeNull()
  })

  test("S22: a text file just under 5 MB is captured whole", async () => {
    const content = "b".repeat(5 * 1024 * 1024 - 1)
    const path = await projectFile("docs/big.md", content)

    const upload = await prepareUpload(deps(), entryFor({ path, created: true }))

    expect(upload?.currentContent).toHaveLength(content.length)
  })

  test("a base over 1 MB is still carried through whole -- capping the rendered diff is the server's job", async () => {
    const base = wideText("b")
    const current = wideText("c")
    const path = await projectFile("docs/wide.md", current)

    const upload = await prepareUpload(
      deps(),
      entryFor({ path, relativePath: "docs/wide.md", base }),
    )

    expect(upload?.baseContent).toBe(base)
    expect(upload?.currentContent).toBe(current)
  })
})

describe("classifyContentType", () => {
  test("S25: mimeType follows the extension while isBinary follows the bytes", () => {
    const nul = Buffer.from("text\u0000more")
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    // A real ftyp box: the same bytes the server sniffs to serve mp4 inline.
    const mp4 = Buffer.from("000000186674797069736f6d", "hex")

    const rows = [
      {
        name: "notes.md",
        content: Buffer.from("# hi"),
        mimeType: "text/markdown",
        isBinary: false,
      },
      { name: "logo.png", content: png, mimeType: "image/png", isBinary: true },
      { name: "run.mp4", content: mp4, mimeType: "video/mp4", isBinary: true },
      {
        name: "main.ts",
        content: Buffer.from("const a = 1"),
        mimeType: "text/x-typescript",
        isBinary: false,
      },
      { name: "LICENSE", content: Buffer.from("MIT"), mimeType: "text/plain", isBinary: false },
      { name: "corrupt.md", content: nul, mimeType: "text/markdown", isBinary: true },
      { name: "blob.bin", content: nul, mimeType: "application/octet-stream", isBinary: true },
    ] as const

    for (const row of rows) {
      const actual = classifyContentType(row.content, row.name)
      expect({ name: row.name, ...actual }).toEqual({
        name: row.name,
        mimeType: row.mimeType,
        isBinary: row.isBinary,
      })
    }
  })

  test("S25: invalid UTF-8 that survives no round trip is binary", () => {
    const invalid = Buffer.from([0xff, 0xfe, 0xfd])

    expect(classifyContentType(invalid, "notes.md").isBinary).toBe(true)
  })
})
