import { createHash } from "node:crypto"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ArtifactUploadPayload } from "@samskara/core"
import { beforeEach, describe, expect, test, vi } from "vitest"
import { type QueueEntry, enqueue, readQueue } from "./artifact-queue.js"
import { advanceArtifactState, readArtifactState, stateKey } from "./artifact-worker.js"
import {
  type ArtifactSink,
  type ArtifactSinkResult,
  type ArtifactWorkerDeps,
  MAX_ATTEMPTS,
  runArtifactWorkers,
} from "./artifact-worker.js"
import { spyLogger } from "./test-logger.js"

const sha256 = (content: string): string => createHash("sha256").update(content).digest("hex")

type Recorder = ArtifactSink & { readonly sent: ReadonlyArray<ArtifactUploadPayload> }

/** Answers with the next scripted status, repeating the last one once the script runs out. */
const scriptedSink = (statuses: ReadonlyArray<number>): Recorder => {
  const sent: ArtifactUploadPayload[] = []
  let index = 0
  return {
    sent,
    send: async (payload): Promise<ArtifactSinkResult> => {
      sent.push(payload)
      const status = statuses[Math.min(index, statuses.length - 1)] ?? 200
      index += 1
      return { status }
    },
  }
}

describe("artifact workers", () => {
  let recorder = spyLogger()
  let dir: string
  let queuePath: string
  let statePath: string
  let filePath: string

  const entry = (over: Partial<QueueEntry> = {}): QueueEntry => ({
    sessionId: "0b9d4c1e-7f3a-4c22-9a6e-1d5f8b2c3e40",
    path: filePath,
    relativePath: "docs/notes.md",
    changeKind: "created",
    observedAt: "2026-07-28T12:00:00.000Z",
    attempts: 0,
    ...over,
  })

  const deps = (sink: ArtifactSink, now = 1_800_000_000_000): ArtifactWorkerDeps => ({
    fileHistoryDir: join(dir, "file-history"),
    log: recorder.log,
    sink,
    clock: { now: () => now },
  })

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "samskara-worker-"))
    queuePath = join(dir, "artifact-queue.json")
    statePath = join(dir, "artifacts.json")
    filePath = join(dir, "notes.md")
    await writeFile(filePath, "current bytes\n", "utf8")
    recorder = spyLogger()
  })

  test("S34: a transient failure is retried with backoff and advances no state", async () => {
    const sink = scriptedSink([500, 409, 200])
    const target = entry()
    const key = stateKey(target.sessionId, target.path)
    await enqueue(queuePath, [target])

    const now = 1_800_000_000_000
    const config = { queuePath, statePath, workers: 1, drainOnce: true }

    // Attempt 1 -- 500. The entry survives with a future nextAttemptAt and no state written.
    await runArtifactWorkers(config, deps(sink, now))
    const afterFirst = await readQueue(queuePath)
    expect(afterFirst.entries).toHaveLength(1)
    expect(afterFirst.entries[0]?.attempts).toBe(1)
    expect(Date.parse(afterFirst.entries[0]?.nextAttemptAt ?? "")).toBeGreaterThan(now)
    expect((await readArtifactState(statePath)).artifacts[key]).toBeUndefined()

    // Attempt 2 -- 409 sessionNotFound. Retryable, not permanent: the entry still survives.
    const later = Date.parse(afterFirst.entries[0]?.nextAttemptAt ?? "") + 1
    await runArtifactWorkers(config, deps(sink, later))
    const afterSecond = await readQueue(queuePath)
    expect(afterSecond.entries).toHaveLength(1)
    expect(afterSecond.entries[0]?.attempts).toBe(2)
    expect((await readArtifactState(statePath)).artifacts[key]).toBeUndefined()

    // Attempt 3 -- 200. The entry is gone and the state records the hash it uploaded.
    const latest = Date.parse(afterSecond.entries[0]?.nextAttemptAt ?? "") + 1
    await runArtifactWorkers(config, deps(sink, latest))
    expect((await readQueue(queuePath)).entries).toHaveLength(0)
    expect((await readArtifactState(statePath)).artifacts[key]).toEqual({
      currentHash: sha256("current bytes\n"),
      baseCaptured: false,
    })
    expect(sink.sent).toHaveLength(3)
  })

  test("S34: an entry whose nextAttemptAt is still in the future is not claimed", async () => {
    const sink = scriptedSink([200])
    const now = 1_800_000_000_000
    await enqueue(queuePath, [
      entry({ attempts: 1, nextAttemptAt: new Date(now + 60_000).toISOString() }),
    ])

    await runArtifactWorkers({ queuePath, statePath, workers: 1, drainOnce: true }, deps(sink, now))

    expect(sink.sent).toHaveLength(0)
    expect((await readQueue(queuePath)).entries).toHaveLength(1)
  })

  test("S35: a permanently rejected entry is dropped without advancing state", async () => {
    const sink = scriptedSink([400])
    const target = entry()
    await enqueue(queuePath, [target])

    await runArtifactWorkers({ queuePath, statePath, workers: 1, drainOnce: true }, deps(sink))

    expect((await readQueue(queuePath)).entries).toHaveLength(0)
    expect(recorder.warn.length).toBeGreaterThan(0)
    // State untouched, so a later edit of the same path re-enqueues and re-uploads it.
    expect(
      (await readArtifactState(statePath)).artifacts[stateKey(target.sessionId, target.path)],
    ).toBeUndefined()
  })

  test("S35: an entry failing five consecutive times is dropped on the fifth without advancing state", async () => {
    const sink = scriptedSink([500])
    const target = entry()
    await enqueue(queuePath, [target])
    const config = { queuePath, statePath, workers: 1, drainOnce: true }

    let now = 1_800_000_000_000
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
      await runArtifactWorkers(config, deps(sink, now))
      const queue = await readQueue(queuePath)
      expect(queue.entries).toHaveLength(1)
      expect(queue.entries[0]?.attempts).toBe(attempt)
      now = Date.parse(queue.entries[0]?.nextAttemptAt ?? "") + 1
    }

    // The fifth attempt exhausts the budget: dropped with a warn, state still untouched.
    await runArtifactWorkers(config, deps(sink, now))
    expect(sink.sent).toHaveLength(MAX_ATTEMPTS)
    expect((await readQueue(queuePath)).entries).toHaveLength(0)
    expect(recorder.warn.length).toBeGreaterThan(0)
    expect(
      (await readArtifactState(statePath)).artifacts[stateKey(target.sessionId, target.path)],
    ).toBeUndefined()
  })

  test("S36: a file whose mtime moved but whose bytes did not is never uploaded", async () => {
    const sink = scriptedSink([200])
    const target = entry()
    await advanceArtifactState(statePath, stateKey(target.sessionId, target.path), {
      currentHash: sha256("current bytes\n"),
      baseCaptured: false,
    })
    await enqueue(queuePath, [target])

    await runArtifactWorkers({ queuePath, statePath, workers: 1, drainOnce: true }, deps(sink))

    // No request reaches the sink at all -- the hash check runs before the network call.
    expect(sink.sent).toHaveLength(0)
    expect((await readQueue(queuePath)).entries).toHaveLength(0)
  })

  test("S37: queued work survives a restart", async () => {
    const second = join(dir, "other.md")
    await writeFile(second, "other bytes\n", "utf8")
    // Written straight to disk: the pool below is constructed fresh, with no in-memory history.
    await enqueue(queuePath, [
      entry(),
      entry({ path: second, relativePath: "docs/other.md", sessionId: "sess-two" }),
    ])

    const sink = scriptedSink([200])
    await runArtifactWorkers({ queuePath, statePath, workers: 3, drainOnce: true }, deps(sink))

    expect(sink.sent.map((payload) => payload.path).sort()).toEqual([filePath, second].sort())
    expect((await readQueue(queuePath)).entries).toHaveLength(0)
  })

  test("S37: three workers never claim the same entry twice", async () => {
    const paths = await Promise.all(
      [0, 1, 2, 3, 4].map(async (index) => {
        const path = join(dir, `file-${index}.md`)
        await writeFile(path, `bytes ${index}\n`, "utf8")
        return path
      }),
    )
    await enqueue(
      queuePath,
      paths.map((path, index) =>
        entry({ path, relativePath: `docs/file-${index}.md`, sessionId: `sess-${index}` }),
      ),
    )

    const sink = scriptedSink([200])
    await runArtifactWorkers({ queuePath, statePath, workers: 3, drainOnce: true }, deps(sink))

    expect(sink.sent).toHaveLength(paths.length)
    expect(new Set(sink.sent.map((payload) => payload.path)).size).toBe(paths.length)
    expect((await readQueue(queuePath)).entries).toHaveLength(0)
  })

  test("a file edited again mid-upload stays queued, so the newer edit is not lost", async () => {
    const target = entry()
    await enqueue(queuePath, [target])

    // The agent edits the file again while the first upload is in flight, so the next cycle
    // re-enqueues the same path with a fresh observedAt. Settling on the claimed entry must not
    // remove it: that edit would then never be uploaded at all.
    const fresh = { ...target, observedAt: new Date(1_800_000_500_000).toISOString() }
    const racingSink: ArtifactSink = {
      send: async () => {
        await enqueue(queuePath, [fresh])
        return { status: 200 }
      },
    }

    // One iteration: claim, race, settle. `stopped` halts the loop before the worker can pick the
    // re-enqueued entry back up, which is what leaves the settle observable.
    let iterations = 0
    await runArtifactWorkers(
      { queuePath, statePath, workers: 1 },
      { ...deps(racingSink), stopped: () => iterations++ > 0 },
    )

    const { entries } = await readQueue(queuePath)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.observedAt).toBe(fresh.observedAt)
  })

  test("a file edited again mid-upload is not overwritten by a retry", async () => {
    const target = entry()
    await enqueue(queuePath, [target])

    const fresh = { ...target, observedAt: new Date(1_800_000_500_000).toISOString() }
    const racingSink: ArtifactSink = {
      send: async () => {
        await enqueue(queuePath, [fresh])
        return { status: 500 }
      },
    }

    let iterations = 0
    await runArtifactWorkers(
      { queuePath, statePath, workers: 1 },
      { ...deps(racingSink), stopped: () => iterations++ > 0 },
    )

    const { entries } = await readQueue(queuePath)
    expect(entries).toHaveLength(1)
    // The fresh observation survives with its own attempt count -- a blind replace would have
    // written back the claimed entry's backoff and resurrected the older observedAt.
    expect(entries[0]?.observedAt).toBe(fresh.observedAt)
    expect(entries[0]?.attempts).toBe(0)
    expect(entries[0]?.nextAttemptAt).toBeUndefined()
  })

  test("S34: an upload carrying a base records baseCaptured", async () => {
    const sessionId = "0b9d4c1e-7f3a-4c22-9a6e-1d5f8b2c3e40"
    const sink = scriptedSink([200])
    const target = entry({ changeKind: "edited", backupFileName: "abc123@v1" })
    await enqueue(queuePath, [target])

    // A real backup on disk rather than a stubbed reader: the @vN lookup is the behaviour under
    // test, and a stub would assert the stub's shape instead of the real directory scan.
    const backupDir = join(dir, "file-history", target.sessionId)
    await mkdir(backupDir, { recursive: true })
    await writeFile(join(backupDir, "abc123@v1"), "base bytes\n", "utf8")
    await writeFile(target.path, "current bytes\n", "utf8")

    await runArtifactWorkers({ queuePath, statePath, workers: 1, drainOnce: true }, deps(sink))

    expect(sink.sent[0]?.baseContent).toBe("base bytes\n")
    expect(
      (await readArtifactState(statePath)).artifacts[stateKey(sessionId, target.path)],
    ).toEqual({ currentHash: sha256("current bytes\n"), baseCaptured: true })
  })

  test("S35: an entry whose file vanished is dropped without an upload and without state", async () => {
    const sink = scriptedSink([200])
    const target = entry({ path: join(dir, "gone.md") })
    await enqueue(queuePath, [target])

    await runArtifactWorkers({ queuePath, statePath, workers: 1, drainOnce: true }, deps(sink))

    expect(sink.sent).toHaveLength(0)
    expect((await readQueue(queuePath)).entries).toHaveLength(0)
    expect(
      (await readArtifactState(statePath)).artifacts[stateKey(target.sessionId, target.path)],
    ).toBeUndefined()
  })
})

describe("artifact state", () => {
  let statePath: string

  beforeEach(async () => {
    statePath = join(await mkdtemp(join(tmpdir(), "samskara-artstate-")), "artifacts.json")
  })

  test("S36: a missing or corrupt state file reads back empty rather than throwing", async () => {
    expect(await readArtifactState(statePath)).toEqual({ version: 1, artifacts: {} })

    await writeFile(statePath, "{not json", "utf8")
    expect(await readArtifactState(statePath)).toEqual({ version: 1, artifacts: {} })

    await writeFile(statePath, JSON.stringify({ version: 2, artifacts: {} }), "utf8")
    expect(await readArtifactState(statePath)).toEqual({ version: 1, artifacts: {} })
  })

  test("S36: advancing one key leaves every other key intact", async () => {
    const first = stateKey("0b9d4c1e-7f3a-4c22-9a6e-1d5f8b2c3e40", "/work/app/a.md")
    const second = stateKey("0b9d4c1e-7f3a-4c22-9a6e-1d5f8b2c3e40", "/work/app/b.md")

    await advanceArtifactState(statePath, first, { currentHash: "aaa", baseCaptured: false })
    await advanceArtifactState(statePath, second, { currentHash: "bbb", baseCaptured: true })
    await advanceArtifactState(statePath, first, { currentHash: "ccc", baseCaptured: true })

    expect((await readArtifactState(statePath)).artifacts).toEqual({
      [first]: { currentHash: "ccc", baseCaptured: true },
      [second]: { currentHash: "bbb", baseCaptured: true },
    })
  })

  test("S36: a Windows-style absolute path keeps its drive colon in the key", async () => {
    // The key splits on the FIRST colon: session ids are UUIDs, so `C:` belongs to the path.
    const key = stateKey("0b9d4c1e-7f3a-4c22-9a6e-1d5f8b2c3e40", "C:\\work\\app\\a.md")
    expect(key).toBe("0b9d4c1e-7f3a-4c22-9a6e-1d5f8b2c3e40:C:\\work\\app\\a.md")
    expect(key.slice(key.indexOf(":") + 1)).toBe("C:\\work\\app\\a.md")
  })
})
