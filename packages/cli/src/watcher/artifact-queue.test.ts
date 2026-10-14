import { mkdtemp, writeFile } from "node:fs/promises"
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
import { readArtifactState, readArtifactStateOrReset } from "./artifact-worker.js"
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
    // The writers stamp via `persistedApiUrl()`, which reads `config.json` under `SAMSKARA_HOME`.
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

  test("S10: re-enqueuing the same (sessionId, path) folds into one entry, keeping the latest observedAt, while another session's write to that path stays separate", async () => {
    await enqueue(queuePath, [entry({ observedAt: "2026-07-28T12:00:00.000Z" })])
    await enqueue(queuePath, [entry({ observedAt: "2026-07-28T12:01:00.000Z" })])
    await enqueue(queuePath, [entry({ sessionId: "sess-2" })])
    await enqueue(queuePath, [entry({ observedAt: "2026-07-28T12:02:00.000Z" })])

    const { entries } = await readQueue(queuePath)
    expect(entries.map((queued) => [queued.sessionId, queued.observedAt])).toEqual([
      ["sess-1", "2026-07-28T12:02:00.000Z"],
      ["sess-2", "2026-07-28T12:00:00.000Z"],
    ])
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
})

describe.each([
  {
    store: "artifact queue",
    read: readQueue,
    readOrReset: readQueueOrReset,
    empty: { version: 1, entries: [] },
  },
  {
    store: "artifact state",
    read: readArtifactState,
    readOrReset: readArtifactStateOrReset,
    empty: { version: 1, artifacts: {} },
  },
])("$store file", ({ read, readOrReset, empty }) => {
  const originalHome = process.env.SAMSKARA_HOME
  let path: string

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), "samskara-store-"))
    path = join(dir, "store.json")
    process.env.SAMSKARA_HOME = dir
  })

  afterEach(() => {
    process.env.SAMSKARA_HOME = originalHome
  })

  test("S12: a missing file reads back empty", async () => {
    expect(await read(path)).toEqual(empty)
  })

  test("S12: a corrupt file throws rather than reading as empty", async () => {
    await writeFile(path, "{not json", "utf8")

    await expect(read(path)).rejects.toThrow()
  })

  test("S12: the reset helper absorbs a corrupt file and repairs it for the next read", async () => {
    await writeFile(path, "{not json", "utf8")

    expect(await readOrReset(path)).toEqual(empty)
    expect(await read(path)).toEqual(empty)
  })
})
