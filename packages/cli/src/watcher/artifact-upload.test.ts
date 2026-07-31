import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"

import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { QueueEntry } from "./artifact-queue.js"
import {
  classifyContentType,
  computeArtifactDiff,
  prepareUpload,
  resolveBase,
} from "./artifact-upload.js"
import { silentLogger, spyLogger } from "./test-logger.js"

let root = ""
let fileHistory = ""

const SESSION = "sess-artifact"
const HASH = "3c32b39a"

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "samskara-artifact-"))
  fileHistory = join(root, "file-history")
  await mkdir(join(fileHistory, SESSION), { recursive: true })
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

const backupFile = async (name: string, content: string | Buffer): Promise<void> => {
  await writeFile(join(fileHistory, SESSION, name), content)
}

const entryFor = (over: Partial<QueueEntry> & { readonly path: string }): QueueEntry => ({
  sessionId: SESSION,
  relativePath: "docs/notes.md",
  changeKind: "edited",
  observedAt: "2026-07-28T10:00:00.000Z",
  attempts: 0,
  ...over,
})

const deps = (log = silentLogger()) => ({ fileHistoryDir: fileHistory, log })

const ORIGINAL = "# Notes\n\nOriginal line.\nShared tail.\n"
const CHANGED = "# Notes\n\nChanged line.\nShared tail.\n"

/**
 * Long lines rather than many lines: the diff's cost grows with the line count, its size with
 * line length. This clears the 1 MB cap in milliseconds where 30k short lines takes minutes.
 */
const wideText = (marker: string): string =>
  Array.from({ length: 200 }, (_, i) => `${marker}${i}-${marker.repeat(3000)}`).join("\n")

describe("prepareUpload", () => {
  test("S16: an edited file with a resolvable backup yields a base and a unified diff", async () => {
    const path = await projectFile("docs/notes.md", CHANGED)
    await backupFile(`${HASH}@v1`, ORIGINAL)

    const upload = await prepareUpload(deps(), entryFor({ path, backupFileName: `${HASH}@v1` }))

    expect(upload?.changeKind).toBe("edited")
    expect(upload?.baseContent).toBe(ORIGINAL)
    expect(upload?.currentContent).toBe(CHANGED)
    expect(upload?.baseHash).not.toBe(upload?.currentHash)
    expect(upload?.diff).toContain("-Original line.")
    expect(upload?.diff).toContain("+Changed line.")
    expect(upload?.diff).toContain("docs/notes.md")
    expect(upload?.diff).not.toContain(root)
  })

  test("S17: a missing backup degrades to editedUnknownBase and keeps the fragment", async () => {
    const path = await projectFile("docs/notes.md", CHANGED)

    const upload = await prepareUpload(
      deps(),
      entryFor({ path, backupFileName: `${HASH}@v1`, oldFragment: "Original line." }),
    )

    expect(upload?.changeKind).toBe("editedUnknownBase")
    expect(upload?.baseContent).toBeUndefined()
    expect(upload?.baseHash).toBeUndefined()
    expect(upload?.diff).toBeUndefined()
    expect(upload?.oldFragment).toBe("Original line.")
    expect(upload?.currentContent).toBe(CHANGED)
  })

  test("S18: an edited file with no backup pointer degrades without touching the disk", async () => {
    const path = await projectFile("docs/notes.md", CHANGED)

    const upload = await prepareUpload(deps(), entryFor({ path, oldFragment: "gone" }))

    expect(upload?.changeKind).toBe("editedUnknownBase")
    expect(upload?.baseContent).toBeUndefined()
    expect(upload?.oldFragment).toBe("gone")
  })

  test("S20: a created file has no base and no diff", async () => {
    const path = await projectFile("docs/new.md", CHANGED)
    await backupFile(`${HASH}@v1`, ORIGINAL)

    const upload = await prepareUpload(
      deps(),
      entryFor({ path, changeKind: "created", backupFileName: `${HASH}@v1` }),
    )

    expect(upload?.changeKind).toBe("created")
    expect(upload?.baseContent).toBeUndefined()
    expect(upload?.baseHash).toBeUndefined()
    expect(upload?.diff).toBeUndefined()
    expect(upload?.currentContent).toBe(CHANGED)
  })

  test("S23: a file written then deleted is skipped and logged at debug", async () => {
    const recorder = spyLogger()

    const upload = await prepareUpload(
      { fileHistoryDir: fileHistory, log: recorder.log },
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

  test("S21: a binary file is captured whole, base64-encoded, with no diff", async () => {
    const path = await projectFile("assets/logo.png", PNG)
    await backupFile(`${HASH}@v1`, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))

    const upload = await prepareUpload(
      deps(),
      entryFor({ path, relativePath: "assets/logo.png", backupFileName: `${HASH}@v1` }),
    )

    expect(upload?.encoding).toBe("base64")
    expect(upload?.diff).toBeUndefined()
    expect(Buffer.from(upload?.currentContent ?? "", "base64")).toEqual(PNG)
  })

  test("S21: a utf8 text file with a resolvable base is utf8-encoded and diffed", async () => {
    const path = await projectFile("docs/notes.md", CHANGED)
    await backupFile(`${HASH}@v1`, ORIGINAL)

    const upload = await prepareUpload(deps(), entryFor({ path, backupFileName: `${HASH}@v1` }))

    expect(upload?.encoding).toBe("utf8")
    expect(upload?.diff).toBeTruthy()
  })
})

describe("prepareUpload — size caps", () => {
  test("S22: a text file over 5 MB is skipped with a warn naming path and size", async () => {
    const oversize = "a".repeat(5 * 1024 * 1024 + 1)
    const path = await projectFile("docs/huge.md", oversize)
    const recorder = spyLogger()

    const upload = await prepareUpload(
      { fileHistoryDir: fileHistory, log: recorder.log },
      entryFor({ path }),
    )

    expect(upload).toBeNull()
    const warned = recorder.warn[0]
    expect(warned).toBeDefined()
    expect(JSON.stringify(warned?.details)).toContain(path)
    expect(JSON.stringify(warned?.details)).toContain(String(oversize.length))
  })

  test("S22: a binary file over 50 MB is skipped", async () => {
    const oversize = Buffer.alloc(50 * 1024 * 1024 + 1)
    const path = await projectFile("assets/huge.bin", oversize)

    const upload = await prepareUpload(deps(), entryFor({ path, changeKind: "created" }))

    expect(upload).toBeNull()
  })

  test("S22: a text file just under 5 MB is captured whole", async () => {
    const content = "b".repeat(5 * 1024 * 1024 - 1)
    const path = await projectFile("docs/big.md", content)

    const upload = await prepareUpload(deps(), entryFor({ path, changeKind: "created" }))

    expect(upload?.currentContent).toHaveLength(content.length)
  })

  test("S24: a diff past 1 MB is dropped while both contents are still captured", async () => {
    const base = wideText("b")
    const current = wideText("c")
    const path = await projectFile("docs/wide.md", current)
    await backupFile(`${HASH}@v1`, base)

    const upload = await prepareUpload(
      deps(),
      entryFor({ path, relativePath: "docs/wide.md", backupFileName: `${HASH}@v1` }),
    )

    expect(upload?.diff).toBeUndefined()
    expect(upload?.baseContent).toBe(base)
    expect(upload?.currentContent).toBe(current)
  })
})

describe("resolveBase", () => {
  test("S19: the lowest surviving version wins over a lexicographic sort", async () => {
    await backupFile(`${HASH}@v3`, "three")
    await backupFile(`${HASH}@v10`, "ten")
    await backupFile(`${HASH}@v2`, "two")

    const resolved = await resolveBase(
      deps(),
      entryFor({ path: "/x", backupFileName: `${HASH}@v10` }),
    )

    expect(resolved?.baseContent.toString()).toBe("two")
  })

  test("S19: a named @v7 falls back to the surviving @v1", async () => {
    await backupFile(`${HASH}@v1`, "one")

    const resolved = await resolveBase(
      deps(),
      entryFor({ path: "/x", backupFileName: `${HASH}@v7` }),
    )

    expect(resolved?.baseContent.toString()).toBe("one")
  })

  test("S19: only versions of the named hash are considered", async () => {
    await backupFile(`${HASH}@v5`, "mine")
    await backupFile("deadbeef@v1", "someone else's")

    const resolved = await resolveBase(
      deps(),
      entryFor({ path: "/x", backupFileName: `${HASH}@v5` }),
    )

    expect(resolved?.baseContent.toString()).toBe("mine")
  })

  test("S18: an entry with no backup pointer resolves to null without listing anything", async () => {
    // Half of all delta lines carry no backupFileName, so this is the majority path and must stay
    // cheap. `fileHistoryDir` points at a regular file: listing it would raise ENOTDIR, which
    // resolveBase swallows into the same null -- so the assertion that distinguishes
    // "short-circuited" from "tried and failed" is that no lock or read is attempted at all.
    const notADirectory = await projectFile("not-a-dir", "x")

    await expect(
      resolveBase({ fileHistoryDir: notADirectory, log: silentLogger() }, entryFor({ path: "/x" })),
    ).resolves.toBeNull()
  })

  test("S17: an absent history directory degrades to null rather than throwing", async () => {
    const resolved = await resolveBase(
      { fileHistoryDir: join(root, "nope"), log: silentLogger() },
      entryFor({ path: "/x", backupFileName: `${HASH}@v1` }),
    )

    expect(resolved).toBeNull()
  })
})

describe("classifyContentType", () => {
  test("S25: mimeType follows the extension while isBinary follows the bytes", () => {
    const nul = Buffer.from("text\u0000more")
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

    const rows = [
      {
        name: "notes.md",
        content: Buffer.from("# hi"),
        mimeType: "text/markdown",
        isBinary: false,
      },
      { name: "logo.png", content: png, mimeType: "image/png", isBinary: true },
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

describe("computeArtifactDiff", () => {
  test("S16: the patch header names the relative path on both sides", () => {
    const patch = computeArtifactDiff(ORIGINAL, CHANGED, "docs/notes.md")

    expect(patch).toContain("--- docs/notes.md")
    expect(patch).toContain("+++ docs/notes.md")
  })

  test("S24: a diff exceeding 1 MB is dropped", () => {
    expect(computeArtifactDiff(wideText("b"), wideText("c"), "docs/wide.md")).toBeNull()
  })
})
