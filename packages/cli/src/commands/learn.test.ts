import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { describe, expect, test, vi } from "vitest"
import { type LearningRow, learnCommand, writeLearnings } from "./learn.js"

const row = (overrides: Partial<LearningRow> = {}): LearningRow => ({
  id: "0b88baf7-1111-2222-3333-444455556666",
  projectId: "p1",
  audience: "agent",
  category: "tool-retry",
  title: "Bash failed 3 times in a row",
  detail: "After the second failure of the same call shape, change the approach.",
  evidence: [{ seq: 4, what: "failure 1 of Bash" }],
  status: "accepted",
  occurrenceCount: 2,
  ...overrides,
})

const jsonRes = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status })

const realTmp = async (): Promise<string> => mkdtemp(join(tmpdir(), "samskara-learn-"))

const HAND_WRITTEN_PATH = "lessons/gotchas/hand-written-lesson-20260801.md"

const HAND_WRITTEN_CONTENT = [
  "---",
  'title: "Hand-written lesson"',
  "date: 2026-08-01",
  "category: gotchas",
  "tags: [vitest, realpath]",
  "status: implemented",
  'applies_to: ["packages/cli/src/watcher/*.test.ts"]',
  "evidence_count: 1",
  "last_validated: 2026-08-01",
  "source: review-fix@hand",
  "related: []",
  "---",
  "",
  "# Hand-written lesson",
  "",
  "Curated by a person; the generator must never delete or overwrite it.",
  "",
].join("\n")

const seedHandWritten = async (
  dir: string,
  relPath: string = HAND_WRITTEN_PATH,
  content: string = HAND_WRITTEN_CONTENT,
): Promise<void> => {
  const abs = join(dir, ".harness/knowledge", relPath)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, content, "utf8")
}

const listMarkdownFiles = async (dir: string): Promise<ReadonlyArray<string>> => {
  const entries = await readdir(dir, { recursive: true })
  return entries.filter((entry) => String(entry).endsWith(".md")).map(String)
}

describe("writeLearnings", () => {
  test("L1: writes LEARNINGS.md, one lesson file per learning, and a merged INDEX", async () => {
    const dir = await realTmp()
    const { written } = await writeLearnings(
      [
        row(),
        row({
          id: "cccc2222-1111-2222-3333-444455556666",
          audience: "human",
          category: "supervision",
          title: "Corrections pile up",
        }),
      ],
      { dir, projectName: "samskara" },
      new Date("2026-08-25T12:00:00Z"),
    )
    expect(written).toContain("LEARNINGS.md")
    expect(written).toContain(".harness/knowledge/INDEX.md")

    const markdown = await readFile(join(dir, "LEARNINGS.md"), "utf8")
    expect(markdown).toContain("# Learnings — samskara")
    expect(markdown).toContain("Bash failed 3 times in a row")

    const lessonDir = join(dir, ".harness/knowledge/lessons/tool-retry")
    const files = await readdir(lessonDir)
    expect(files).toContain("bash-failed-3-times-in-a-row-20260825.md")
    const lesson = await readFile(join(lessonDir, files[0] as string), "utf8")
    expect(lesson).toContain("source: samskara-learning://0b88baf7")
    expect(lesson).toContain("occurrence_count: 2")

    const index = await readFile(join(dir, ".harness/knowledge/INDEX.md"), "utf8")
    expect(index).toContain("Bash failed 3 times in a row")
    expect(index).toContain("Corrections pile up")
  })

  test("L2: zero rows leaves hand-written lessons and their INDEX entries intact", async () => {
    const dir = await realTmp()
    await seedHandWritten(dir)
    const { written } = await writeLearnings([], { dir, projectName: "x" }, new Date())

    expect(written).toContain("LEARNINGS.md")
    expect(written).toContain(".harness/knowledge/INDEX.md")

    const lesson = await readFile(join(dir, ".harness/knowledge", HAND_WRITTEN_PATH), "utf8")
    expect(lesson).toBe(HAND_WRITTEN_CONTENT)

    const index = await readFile(join(dir, ".harness/knowledge/INDEX.md"), "utf8")
    expect(index).toContain(
      "[Hand-written lesson](lessons/gotchas/hand-written-lesson-20260801.md)",
    )
    expect(index).toContain("tags: vitest, realpath")

    const markdown = await readFile(join(dir, "LEARNINGS.md"), "utf8")
    expect(markdown).toContain("No learnings yet")
  })

  test("L7: the INDEX merges hand-written entries with generated ones", async () => {
    const dir = await realTmp()
    await seedHandWritten(dir)
    await writeLearnings(
      [row()],
      { dir, projectName: "samskara" },
      new Date("2026-08-25T12:00:00Z"),
    )

    const index = await readFile(join(dir, ".harness/knowledge/INDEX.md"), "utf8")
    expect(index).toContain(
      "[Hand-written lesson](lessons/gotchas/hand-written-lesson-20260801.md)",
    )
    expect(index).toContain("Bash failed 3 times in a row")

    const lesson = await readFile(join(dir, ".harness/knowledge", HAND_WRITTEN_PATH), "utf8")
    expect(lesson).toBe(HAND_WRITTEN_CONTENT)
  })

  test("L8: pruning removes only previously generated files, never hand-written ones", async () => {
    const dir = await realTmp()
    await seedHandWritten(dir)
    const first = await writeLearnings(
      [row(), row({ id: "2a2a2a2a-1111-2222-3333-444455556666", title: "Second lesson" })],
      { dir, projectName: "samskara" },
      new Date("2026-08-25T12:00:00Z"),
    )
    expect(first.written).toContain(
      ".harness/knowledge/lessons/tool-retry/second-lesson-20260825.md",
    )

    const second = await writeLearnings([row()], { dir, projectName: "samskara" }, new Date())
    expect(second.pruned).toContain(
      ".harness/knowledge/lessons/tool-retry/second-lesson-20260825.md",
    )

    const lessonDir = join(dir, ".harness/knowledge/lessons/tool-retry")
    expect(await listMarkdownFiles(lessonDir)).toEqual(["bash-failed-3-times-in-a-row-20260825.md"])
    const lesson = await readFile(join(dir, ".harness/knowledge", HAND_WRITTEN_PATH), "utf8")
    expect(lesson).toBe(HAND_WRITTEN_CONTENT)
  })

  test("L9: regenerating on a later date keeps the stable slug - no second file for one learning", async () => {
    const dir = await realTmp()
    const first = await writeLearnings(
      [row()],
      { dir, projectName: "samskara" },
      new Date("2026-08-25T12:00:00Z"),
    )
    const stablePath =
      ".harness/knowledge/lessons/tool-retry/bash-failed-3-times-in-a-row-20260825.md"
    expect(first.written).toContain(stablePath)

    const second = await writeLearnings(
      [row()],
      { dir, projectName: "samskara" },
      new Date("2026-09-30T12:00:00Z"),
    )
    expect(second.written).toContain(stablePath)
    expect(second.pruned).toEqual([])

    const lessonDir = join(dir, ".harness/knowledge/lessons/tool-retry")
    expect(await listMarkdownFiles(lessonDir)).toEqual(["bash-failed-3-times-in-a-row-20260825.md"])
    const index = await readFile(join(dir, ".harness/knowledge/INDEX.md"), "utf8")
    expect(index.match(/Bash failed 3 times in a row/g)).toHaveLength(1)
  })

  test("L10: a learning already present must not ship twice", async () => {
    const dir = await realTmp()

    const duplicated = await writeLearnings(
      [row(), row({ title: "Bash failed 3 times in a row" })],
      { dir, projectName: "samskara" },
      new Date("2026-08-25T12:00:00Z"),
    )
    expect(duplicated.written).toContain(
      ".harness/knowledge/lessons/tool-retry/bash-failed-3-times-in-a-row-20260825.md",
    )
    const lessonDir = join(dir, ".harness/knowledge/lessons/tool-retry")
    expect(await listMarkdownFiles(lessonDir)).toEqual(["bash-failed-3-times-in-a-row-20260825.md"])

    const curated = await realTmp()
    const curatedPath = "lessons/tool-retry/bash-failed-3-times-in-a-row-20260825.md"
    await seedHandWritten(curated, curatedPath, HAND_WRITTEN_CONTENT)
    const result = await writeLearnings(
      [row()],
      { dir: curated, projectName: "samskara" },
      new Date("2026-08-25T12:00:00Z"),
    )
    expect(result.written).not.toContain(`.harness/knowledge/${curatedPath}`)
    expect(await readFile(join(curated, ".harness/knowledge", curatedPath), "utf8")).toBe(
      HAND_WRITTEN_CONTENT,
    )
    const index = await readFile(join(curated, ".harness/knowledge/INDEX.md"), "utf8")
    expect(
      index.match(/lessons\/tool-retry\/bash-failed-3-times-in-a-row-20260825\.md/g),
    ).toHaveLength(1)
  })
})

// A Response body can only be read once, so each test gets its own copy.
const resolveList = (): Response =>
  jsonRes(200, {
    projects: [
      { id: "11111111-2222-3333-4444-555566667777", name: "Samskara Web", slug: "samskara-web" },
      { id: "99999999-8888-7777-6666-555544443333", name: "Other", slug: "other" },
    ],
  })

describe("learnCommand", () => {
  test("L3: without --write it prints learnings and the write hint", async () => {
    const out: string[] = []
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonRes(200, { learnings: [row()] }))
    const code = await learnCommand({
      apiBase: "http://api.test",
      token: "tok",
      fetch: fetchMock as unknown as typeof fetch,
      stdout: { write: (l: string) => out.push(l) },
    })
    expect(code).toBe(0)
    const text = out.join("")
    expect(text).toContain("[agent] Bash failed 3 times in a row")
    expect(text).toContain("seen 2x")
    expect(text).toContain("samskara learn --write")
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("status=accepted")
  })

  test("L4: --write --project <name> resolves the name, filters by its id, and says what it wrote", async () => {
    const dir = await realTmp()
    const out: string[] = []
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonRes(200, {
          projects: [
            { id: "11111111-2222-3333-4444-555566667777", name: "samskara", slug: "samskara" },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonRes(200, { learnings: [row()] }))
    const code = await learnCommand({
      write: true,
      out: dir,
      project: "samskara",
      apiBase: "http://api.test",
      token: "tok",
      fetch: fetchMock as unknown as typeof fetch,
      stdout: { write: (l: string) => out.push(l) },
    })
    expect(code).toBe(0)
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/projects/resolve")
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
      "projectId=11111111-2222-3333-4444-555566667777",
    )
    const text = out.join("")
    expect(text).toContain("wrote LEARNINGS.md")
    expect(text).toContain("wrote .harness/knowledge/INDEX.md")
    const markdown = await readFile(join(dir, "LEARNINGS.md"), "utf8")
    expect(markdown).toContain("# Learnings — samskara")
  })

  test("L5: not paired exits 1 with the hint", async () => {
    const out: string[] = []
    const code = await learnCommand({
      apiBase: "http://api.test",
      token: null,
      fetch: vi.fn(),
      stdout: { write: (l: string) => out.push(l) },
    })
    expect(code).toBe(1)
    expect(out.join("")).toContain("samskara login")
  })

  test("L6: unreachable server exits 1 with the reach message", async () => {
    const out: string[] = []
    const code = await learnCommand({
      apiBase: "http://api.test",
      token: "tok",
      fetch: vi.fn().mockRejectedValue(new Error("net")),
      stdout: { write: (l: string) => out.push(l) },
    })
    expect(code).toBe(1)
    expect(out.join("")).toContain("Could not reach")
  })

  test("L11: --project <slug> resolves by slug and filters the fetch", async () => {
    const out: string[] = []
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(resolveList())
      .mockResolvedValueOnce(jsonRes(200, { learnings: [row()] }))
    const code = await learnCommand({
      project: "samskara-web",
      apiBase: "http://api.test",
      token: "tok",
      fetch: fetchMock as unknown as typeof fetch,
      stdout: { write: (l: string) => out.push(l) },
    })
    expect(code).toBe(0)
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/projects/resolve")
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
      "projectId=11111111-2222-3333-4444-555566667777",
    )
    expect(out.join("")).toContain("[agent] Bash failed 3 times in a row")
  })

  test("L12: --project <name with spaces> resolves by name", async () => {
    const out: string[] = []
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(resolveList())
      .mockResolvedValueOnce(jsonRes(200, { learnings: [row()] }))
    const code = await learnCommand({
      project: "Samskara Web",
      apiBase: "http://api.test",
      token: "tok",
      fetch: fetchMock as unknown as typeof fetch,
      stdout: { write: (l: string) => out.push(l) },
    })
    expect(code).toBe(0)
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
      "projectId=11111111-2222-3333-4444-555566667777",
    )
  })

  test("L13: --project <bogus> exits non-zero, explains, and writes nothing", async () => {
    const dir = await realTmp()
    const out: string[] = []
    const fetchMock = vi.fn().mockResolvedValueOnce(resolveList())
    const code = await learnCommand({
      write: true,
      out: dir,
      project: "bogus",
      apiBase: "http://api.test",
      token: "tok",
      fetch: fetchMock as unknown as typeof fetch,
      stdout: { write: (l: string) => out.push(l) },
    })
    expect(code).toBe(1)
    const text = out.join("")
    expect(text).toContain("--project bogus")
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(await readFile(join(dir, "LEARNINGS.md"), "utf8").catch(() => null)).toBeNull()
  })

  test("L14: --project <uuid> skips resolution and filters directly by the id", async () => {
    const out: string[] = []
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonRes(200, { learnings: [row()] }))
    const code = await learnCommand({
      project: "1b2c3d4e-5f60-4a1b-8c2d-3e4f5a6b7c8d",
      apiBase: "http://api.test",
      token: "tok",
      fetch: fetchMock as unknown as typeof fetch,
      stdout: { write: (l: string) => out.push(l) },
    })
    expect(code).toBe(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "projectId=1b2c3d4e-5f60-4a1b-8c2d-3e4f5a6b7c8d",
    )
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain("/api/projects/resolve")
  })
})
