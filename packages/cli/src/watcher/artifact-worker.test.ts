import { createHash } from "node:crypto"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
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

/**
 * `isCapturable` always excludes `/tmp` and `/private/tmp` outright (containment.ts), and under
 * some runners `os.tmpdir()` resolves to exactly that root when `$TMPDIR` isn't inherited. `/var/tmp`
 * is the same kind of OS-provided scratch space without colliding with that exclusion.
 */
const scratchRoot = (): string =>
  ["/tmp", "/private/tmp"].includes(tmpdir()) ? "/var/tmp" : tmpdir()

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
    dir = await mkdtemp(join(scratchRoot(), "samskara-worker-"))
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

  test("S1: an HTML artifact's referenced video is queued under the referencing session", async () => {
    const reportPath = join(dir, "docs", "report.html")
    await mkdir(dirname(reportPath), { recursive: true })
    await writeFile(reportPath, '<video src="../clips/run.mp4"></video>', "utf8")
    await mkdir(join(dir, "clips"), { recursive: true })
    await writeFile(join(dir, "clips", "run.mp4"), "video bytes", "utf8")

    const report = entry({
      path: reportPath,
      relativePath: "docs/report.html",
      sessionId: "report-session",
    })
    await enqueue(queuePath, [report])

    const sink = scriptedSink([200])
    await runArtifactWorkers({ queuePath, statePath, workers: 1, drainOnce: true }, deps(sink))

    const video = sink.sent.find((payload) => payload.path === join(dir, "clips", "run.mp4"))
    expect(video?.sessionId).toBe(report.sessionId)
    expect(video?.changeKind).toBe("created")
    expect(video?.relativePath).toBe("clips/run.mp4")
    expect((await readQueue(queuePath)).entries).toHaveLength(0)
  })

  test("S7: references that cannot be captured are dropped, per reference rather than per document", async () => {
    const reportPath = join(dir, "pages", "report.md")
    await mkdir(dirname(reportPath), { recursive: true })
    await mkdir(join(dir, "pages", "adir"), { recursive: true })
    await mkdir(join(dir, "node_modules", "pkg"), { recursive: true })
    await writeFile(join(dir, "pages", "ok.png"), "ok bytes", "utf8")
    await writeFile(join(dir, ".env"), "SECRET=1", "utf8")
    await writeFile(join(dir, "node_modules", "pkg", "a.js"), "module.exports = {}", "utf8")
    await writeFile(join(dirname(dir), "outside.png"), "outside bytes", "utf8")
    await writeFile(
      reportPath,
      [
        '<img src="missing.png">',
        '<img src="adir">',
        '<img src="../../outside.png">',
        '<img src="../.env">',
        '<img src="../node_modules/pkg/a.js">',
        '<img src="ok.png">',
      ].join("\n"),
      "utf8",
    )

    const report = entry({ path: reportPath, relativePath: "pages/report.md" })
    await enqueue(queuePath, [report])

    const sink = scriptedSink([200])
    await runArtifactWorkers({ queuePath, statePath, workers: 1, drainOnce: true }, deps(sink))

    expect(sink.sent.map((payload) => payload.path).sort()).toEqual(
      [reportPath, join(dir, "pages", "ok.png")].sort(),
    )
  })

  test("S9: only text .html/.htm/.md artifacts are scanned for references", async () => {
    const targets = {
      md: join(dir, "target-md.dat"),
      html: join(dir, "target-html.dat"),
      txt: join(dir, "target-txt.dat"),
      ts: join(dir, "target-ts.dat"),
      png: join(dir, "target-png.dat"),
    }
    await Promise.all(Object.values(targets).map((path) => writeFile(path, "target bytes", "utf8")))

    const docMd = join(dir, "doc.md")
    const docHtml = join(dir, "doc.html")
    const docTxt = join(dir, "doc.txt")
    const docTs = join(dir, "doc.ts")
    const docPng = join(dir, "doc.png")
    await writeFile(docMd, 'href="target-md.dat"', "utf8")
    await writeFile(docHtml, 'href="target-html.dat"', "utf8")
    await writeFile(docTxt, 'href="target-txt.dat"', "utf8")
    await writeFile(docTs, 'href="target-ts.dat"', "utf8")
    await writeFile(docPng, Buffer.concat([Buffer.from('href="target-png.dat"'), Buffer.from([0])]))

    await enqueue(queuePath, [
      entry({ path: docMd, relativePath: "doc.md" }),
      entry({ path: docHtml, relativePath: "doc.html", sessionId: "sess-2" }),
      entry({ path: docTxt, relativePath: "doc.txt", sessionId: "sess-3" }),
      entry({ path: docTs, relativePath: "doc.ts", sessionId: "sess-4" }),
      entry({ path: docPng, relativePath: "doc.png", sessionId: "sess-5" }),
    ])

    const sink = scriptedSink([200])
    await runArtifactWorkers({ queuePath, statePath, workers: 1, drainOnce: true }, deps(sink))

    const sentPaths = new Set(sink.sent.map((payload) => payload.path))
    expect(sentPaths.has(targets.md)).toBe(true)
    expect(sentPaths.has(targets.html)).toBe(true)
    expect(sentPaths.has(targets.txt)).toBe(false)
    expect(sentPaths.has(targets.ts)).toBe(false)
    expect(sentPaths.has(targets.png)).toBe(false)
  })

  test("S10: a failed upload seeds nothing", async () => {
    const reportPath = join(dir, "report.md")
    await writeFile(reportPath, 'href="target.dat"', "utf8")
    await writeFile(join(dir, "target.dat"), "target bytes", "utf8")
    const report = entry({ path: reportPath, relativePath: "report.md" })
    await enqueue(queuePath, [report])

    const retrySink = scriptedSink([500])
    await runArtifactWorkers({ queuePath, statePath, workers: 1, drainOnce: true }, deps(retrySink))

    expect(retrySink.sent).toHaveLength(1)
    const afterRetry = await readQueue(queuePath)
    expect(afterRetry.entries).toHaveLength(1)
    expect(afterRetry.entries[0]?.path).toBe(reportPath)

    const later = Date.parse(afterRetry.entries[0]?.nextAttemptAt ?? "") + 1
    const dropSink = scriptedSink([404])
    await runArtifactWorkers(
      { queuePath, statePath, workers: 1, drainOnce: true },
      deps(dropSink, later),
    )

    expect((await readQueue(queuePath)).entries).toHaveLength(0)
    expect(dropSink.sent.some((payload) => payload.path === join(dir, "target.dat"))).toBe(false)
  })

  test("S11: mutually referencing documents settle without repeated uploads", async () => {
    const aPath = join(dir, "a.md")
    const bPath = join(dir, "b.md")
    await writeFile(aPath, 'href="b.md"', "utf8")
    await writeFile(bPath, 'href="a.md"', "utf8")

    const sessionId = "mutual-session"
    await enqueue(queuePath, [entry({ path: aPath, relativePath: "a.md", sessionId })])

    const sink = scriptedSink([200])
    await runArtifactWorkers({ queuePath, statePath, workers: 1, drainOnce: true }, deps(sink))

    expect((await readQueue(queuePath)).entries).toHaveLength(0)
    expect(sink.sent.filter((payload) => payload.path === aPath)).toHaveLength(1)
    expect(sink.sent.filter((payload) => payload.path === bPath)).toHaveLength(1)

    const state = await readArtifactState(statePath)
    expect(state.artifacts[stateKey(sessionId, aPath)]).toBeDefined()
    expect(state.artifacts[stateKey(sessionId, bPath)]).toBeDefined()
  })

  test("S12: an already-captured document is not rescanned", async () => {
    const reportPath = join(dir, "report.md")
    const content = 'href="video.mp4"'
    await writeFile(reportPath, content, "utf8")
    await writeFile(join(dir, "video.mp4"), "video bytes", "utf8")

    const report = entry({ path: reportPath, relativePath: "report.md" })
    await advanceArtifactState(statePath, stateKey(report.sessionId, reportPath), {
      currentHash: sha256(content),
      baseCaptured: false,
    })
    await enqueue(queuePath, [report])

    const sink = scriptedSink([200])
    await runArtifactWorkers({ queuePath, statePath, workers: 1, drainOnce: true }, deps(sink))

    expect(sink.sent).toHaveLength(0)
    expect((await readQueue(queuePath)).entries).toHaveLength(0)
  })

  test("S13 (regression): an artifact with no references uploads exactly as before", async () => {
    const target = entry()
    await enqueue(queuePath, [target])

    const sink = scriptedSink([200])
    await runArtifactWorkers({ queuePath, statePath, workers: 1, drainOnce: true }, deps(sink))

    expect(sink.sent).toHaveLength(1)
    expect((await readQueue(queuePath)).entries).toHaveLength(0)
    expect(
      (await readArtifactState(statePath)).artifacts[stateKey(target.sessionId, target.path)],
    ).toEqual({ currentHash: sha256("current bytes\n"), baseCaptured: false })
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
