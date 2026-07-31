import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, test, vi } from "vitest"
import {
  QUEUE_DEPTH_WARN_THRESHOLD,
  type QueueEntry,
  enqueue,
  readQueue,
} from "./artifact-queue.js"
import { spyLogger } from "./test-logger.js"

const entry = (over: Partial<QueueEntry> = {}): QueueEntry => ({
  sessionId: "sess-1",
  path: "/work/app/docs/a.md",
  relativePath: "docs/a.md",
  changeKind: "edited",
  observedAt: "2026-07-28T12:00:00.000Z",
  attempts: 0,
  ...over,
})

describe("artifact queue", () => {
  let queuePath: string

  beforeEach(async () => {
    queuePath = join(await mkdtemp(join(tmpdir(), "samskara-queue-")), "artifact-queue.json")
  })

  test("S12: an entry with every optional field populated round-trips unchanged", async () => {
    const full = entry({
      backupFileName: "3c32b39a@v1",
      oldFragment: "before",
      nextAttemptAt: "2026-07-28T12:05:00.000Z",
      attempts: 2,
    })

    await enqueue(queuePath, [full])

    expect((await readQueue(queuePath)).entries).toEqual([full])
  })

  test("S12: a queue file whose version is not 1 reads back empty", async () => {
    await writeFile(queuePath, JSON.stringify({ version: 2, entries: [entry()] }), "utf8")

    expect(await readQueue(queuePath)).toEqual({ version: 1, entries: [] })
  })

  test("S12: a missing queue file reads back empty", async () => {
    expect(await readQueue(queuePath)).toEqual({ version: 1, entries: [] })
  })

  test("S12: a corrupt queue file reads back empty rather than throwing", async () => {
    await writeFile(queuePath, "{not json", "utf8")

    expect(await readQueue(queuePath)).toEqual({ version: 1, entries: [] })
  })

  test("S10: re-enqueuing the same (sessionId, path) replaces rather than appends", async () => {
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

  test("S10: a replaced entry preserves nothing from the entry it replaced", async () => {
    await enqueue(queuePath, [entry({ attempts: 7, oldFragment: "stale" })])
    await enqueue(queuePath, [entry({ attempts: 0 })])

    const [only] = (await readQueue(queuePath)).entries
    expect(only?.attempts).toBe(0)
    expect(only?.oldFragment).toBeUndefined()
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

  test("the queue file is written as pretty JSON, matching the other config files", async () => {
    await enqueue(queuePath, [entry()])

    expect(await readFile(queuePath, "utf8")).toContain('\n  "version": 1')
  })
})
