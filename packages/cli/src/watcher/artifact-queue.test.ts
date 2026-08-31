import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { writeSettings } from "../config/settings.js"
import {
  type ArtifactQueueEntry,
  enqueue,
  keyOf,
  QUEUE_DEPTH_WARN_THRESHOLD,
  readQueue,
  readQueueOrReset,
} from "./artifact-queue.js"
import { spyLogger } from "./test-logger.js"

const entry = (over: Partial<ArtifactQueueEntry> = {}): ArtifactQueueEntry => ({
  sessionId: "sess-1",
  path: "/work/app/docs/a.md",
  relativePath: "docs/a.md",
  projectRoot: "/work/app",
  created: false,
  observedAt: "2026-07-28T12:00:00.000Z",
  attempts: 0,
  ...over,
})

describe("artifact queue", () => {
  const originalHome = process.env.SAMSKARA_HOME
  let queuePath: string

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), "samskara-queue-"))
    queuePath = join(dir, "artifact-queue.json")
    // `enqueue` stamps `apiBase` via `persistedApiUrl()`, which reads `config.json` under
    // `SAMSKARA_HOME` -- isolated so a test stamps a temp server rather than this machine's real one.
    process.env.SAMSKARA_HOME = dir
  })

  afterEach(() => {
    process.env.SAMSKARA_HOME = originalHome
  })

  test("S10: the key joins on a colon, which a session id can never contain", () => {
    // Session ids are UUIDs, so the FIRST colon is always the separator and a drive letter or a
    // colon inside the path stays on the path side. This matches `stateKey` in the worker.
    const uuid = "0b9d4c1e-7f3a-4c22-9a6e-1d5f8b2c3e40"
    const key = keyOf(entry({ sessionId: uuid, path: "C:\\work\\app\\a.md" }))

    expect(key).toBe(`${uuid}:C:\\work\\app\\a.md`)
    expect(key.slice(0, key.indexOf(":"))).toBe(uuid)
    expect(key.slice(key.indexOf(":") + 1)).toBe("C:\\work\\app\\a.md")
    // No control characters: this string is written into git-tracked source and JSON on disk.
    expect(key).not.toMatch(/\p{Cc}/u)
  })

  test("S10: two paths under one session, and one path across two sessions, all key apart", () => {
    const a = keyOf(entry({ sessionId: "sess-1", path: "/work/app/a.md" }))
    const b = keyOf(entry({ sessionId: "sess-1", path: "/work/app/b.md" }))
    const c = keyOf(entry({ sessionId: "sess-2", path: "/work/app/a.md" }))

    expect(new Set([a, b, c]).size).toBe(3)
  })

  test("S12: an entry with every optional field populated round-trips unchanged", async () => {
    const full = entry({
      base: "original content",
      nextAttemptAt: "2026-07-28T12:05:00.000Z",
      attempts: 2,
    })

    await enqueue(queuePath, [full])

    expect((await readQueue(queuePath)).entries).toEqual([full])
  })

  test("S12: a missing queue file reads back empty", async () => {
    expect(await readQueue(queuePath)).toEqual({ version: 1, entries: [] })
  })

  test("S12: a queue file whose version is not 1 throws rather than reading as empty", async () => {
    await writeFile(queuePath, JSON.stringify({ version: 2, entries: [entry()] }), "utf8")

    await expect(readQueue(queuePath)).rejects.toThrow()
  })

  test("S12: a corrupt queue file throws rather than reading as empty", async () => {
    await writeFile(queuePath, "{not json", "utf8")

    await expect(readQueue(queuePath)).rejects.toThrow()
  })

  test("S12: the reset helper absorbs a corrupt file and repairs it for the next read", async () => {
    await writeFile(queuePath, "{not json", "utf8")

    expect(await readQueueOrReset(queuePath)).toEqual({ version: 1, entries: [] })
    // Repaired on disk, so the throwing form now succeeds too.
    expect(await readQueue(queuePath)).toEqual({ version: 1, entries: [] })
  })

  test("S10: re-enqueuing the same (sessionId, path) folds into one entry, keeping the latest observedAt", async () => {
    await enqueue(queuePath, [entry({ observedAt: "2026-07-28T12:00:00.000Z" })])
    await enqueue(queuePath, [entry({ observedAt: "2026-07-28T12:01:00.000Z" })])
    await enqueue(queuePath, [entry({ observedAt: "2026-07-28T12:02:00.000Z" })])

    const { entries } = await readQueue(queuePath)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.observedAt).toBe("2026-07-28T12:02:00.000Z")
  })

  test("S10: the same path under a different session is a separate entry", async () => {
    await enqueue(queuePath, [entry({ sessionId: "sess-1" })])
    await enqueue(queuePath, [entry({ sessionId: "sess-2" })])

    expect((await readQueue(queuePath)).entries).toHaveLength(2)
  })

  test("S10: folding carries the earlier base forward rather than discarding it", async () => {
    await enqueue(queuePath, [entry({ base: "original" })])
    await enqueue(queuePath, [entry({})])

    const [only] = (await readQueue(queuePath)).entries
    expect(only?.base).toBe("original")
  })

  test("SC18: a base queued while an earlier entry is still pending survives the fold, and the backoff is not bypassed", async () => {
    await enqueue(queuePath, [
      entry({ base: "original", attempts: 2, nextAttemptAt: "2026-07-28T12:05:00.000Z" }),
    ])
    await enqueue(queuePath, [entry({ observedAt: "2026-07-28T12:03:00.000Z" })])

    const [only] = (await readQueue(queuePath)).entries
    expect(only?.base).toBe("original")
    expect(only?.observedAt).toBe("2026-07-28T12:03:00.000Z")
    expect(only?.nextAttemptAt).toBe("2026-07-28T12:05:00.000Z")
    expect(only?.attempts).toBe(2)
  })

  test("SC18: created is sticky across a fold, and a later cycle's attempts never bypass an earlier backoff", async () => {
    await enqueue(queuePath, [entry({ created: true, attempts: 3 })])
    await enqueue(queuePath, [entry({ created: false, attempts: 0 })])

    const [only] = (await readQueue(queuePath)).entries
    expect(only?.created).toBe(true)
    expect(only?.attempts).toBe(3)
  })

  test("S11: passing the depth threshold warns once and discards nothing", async () => {
    const seeded = Array.from({ length: QUEUE_DEPTH_WARN_THRESHOLD }, (_, index) =>
      entry({ path: `/work/app/docs/${index}.md`, relativePath: `docs/${index}.md` }),
    )
    await enqueue(queuePath, seeded)

    const recorder = spyLogger()
    await enqueue(
      queuePath,
      [entry({ path: "/work/app/docs/last.md", relativePath: "docs/last.md" })],
      recorder.log,
    )

    const { entries } = await readQueue(queuePath)
    expect(entries).toHaveLength(QUEUE_DEPTH_WARN_THRESHOLD + 1)
    expect(recorder.warn).toHaveLength(1)
    expect(recorder.warn[0]?.details).toMatchObject({ depth: QUEUE_DEPTH_WARN_THRESHOLD + 1 })
  })

  test("S11: staying at or below the threshold does not warn", async () => {
    const recorder = spyLogger()
    await enqueue(queuePath, [entry()], recorder.log)

    expect(recorder.warn).toHaveLength(0)
  })

  test("SC13: queueing an artifact records the server, and the entry stays readable and claimable", async () => {
    await writeSettings({ apiUrl: "https://one.example", webUrl: "https://one.example" })

    await enqueue(queuePath, [entry()])

    const queue = await readQueue(queuePath)
    expect(queue.apiBase).toBe("https://one.example")
    expect(queue.entries).toEqual([entry()])

    // `claim()` reads through `readQueueOrReset` -- a schema that rejected the new field would
    // silently reset the file here instead of returning the entry.
    expect(await readQueueOrReset(queuePath)).toEqual(queue)
  })

  test("the queue file is written as pretty JSON, matching the other config files", async () => {
    await enqueue(queuePath, [entry()])

    expect(await readFile(queuePath, "utf8")).toContain('\n  "version": 1')
  })
})
