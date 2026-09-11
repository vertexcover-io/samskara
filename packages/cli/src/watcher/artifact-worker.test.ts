import { createHash, randomUUID } from "node:crypto"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import type { ArtifactUploadPayload } from "@samskara/core"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { writeSettings } from "../config/settings.js"
import { runGitOrNull } from "../git.js"
import { type ArtifactQueueEntry, enqueue, readQueue } from "./artifact-queue.js"
import {
  type ArtifactSink,
  type ArtifactSinkResult,
  type ArtifactWorkerDeps,
  advanceArtifactState,
  MAX_ATTEMPTS,
  readArtifactState,
  readArtifactStateOrReset,
  runArtifactWorkers,
  stateKey,
} from "./artifact-worker.js"
import { spyLogger } from "./test-logger.js"

// A real repo with nothing tracked, which is what most tests want. `restoreMocks` restores this
// implementation between tests, so only tests needing something else program it.
vi.mock("../git.js", () => ({
  runGitOrNull: vi.fn(async (args: ReadonlyArray<string>) =>
    args.includes("--is-inside-work-tree") ? "true" : "",
  ),
}))

const git = vi.mocked(runGitOrNull)

const sha256 = (content: string): string => createHash("sha256").update(content).digest("hex")

/** Mirrors `git ls-files -z`: tracked paths only, NUL-terminated, in git's order not the caller's. */
const gitTracking = (tracked: ReadonlyArray<string> | null): void => {
  git.mockImplementation(async (args) => {
    if (args.includes("--is-inside-work-tree")) return "true"
    return tracked === null ? null : tracked.map((path) => `${path}\0`).join("")
  })
}

/** Every git call refuses, which is how a project that is not a repo answers. */
const gitNotARepo = (): void => {
  git.mockImplementation(async () => null)
}

/** The classification calls only -- the repo check that precedes them is not what these assert on. */
const lsFilesArgs = (): ReadonlyArray<ReadonlyArray<string>> =>
  git.mock.calls.map(([args]) => args).filter((args) => args.includes("ls-files"))

/**
 * `isCapturable` excludes `/tmp` and `/private/tmp` outright, and `os.tmpdir()` falls back to
 * exactly that root when `$TMPDIR` is unset. `/var/tmp` is equivalent scratch space without the
 * collision.
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
  const originalHome = process.env.SAMSKARA_HOME
  let recorder = spyLogger()
  let dir: string
  let queuePath: string
  let statePath: string
  let filePath: string

  const entry = (over: Partial<ArtifactQueueEntry> = {}): ArtifactQueueEntry => ({
    sessionId: "0b9d4c1e-7f3a-4c22-9a6e-1d5f8b2c3e40",
    path: filePath,
    relativePath: "docs/notes.md",
    projectRoot: dir,
    created: true,
    observedAt: "2026-07-28T12:00:00.000Z",
    attempts: 0,
    ...over,
  })

  const deps = (sink: ArtifactSink, now = 1_800_000_000_000): ArtifactWorkerDeps => ({
    log: recorder.log,
    sink,
    clock: { now: () => now },
  })

  beforeEach(async () => {
    // Realpath'd so it agrees with the worker's own realpath'd reference candidates -- on macOS
    // `/var` is itself a symlink to `/private/var`, and a raw mkdtemp path would never match.
    dir = await realpath(await mkdtemp(join(scratchRoot(), "samskara-worker-")))
    queuePath = join(dir, "artifact-queue.json")
    statePath = join(dir, "artifacts.json")
    filePath = join(dir, "notes.md")
    await writeFile(filePath, "current bytes\n", "utf8")
    recorder = spyLogger()
    // The writers stamp via `persistedApiUrl()`, which reads `config.json` under `SAMSKARA_HOME`.
    process.env.SAMSKARA_HOME = dir
  })

  afterEach(() => {
    process.env.SAMSKARA_HOME = originalHome
  })

  test("a 401 is retried rather than dropped, so a later `samskara login` still syncs the artifact", async () => {
    const sink = scriptedSink([401, 200])
    const target = entry()
    const key = stateKey(target.sessionId, target.path)
    await enqueue(queuePath, [target])

    const now = 1_800_000_000_000
    const config = { queuePath, statePath, workers: 1, drainOnce: true }

    // Stale credentials: the entry must survive, because logging in again fixes it.
    await runArtifactWorkers(config, deps(sink, now))
    const afterFirst = await readQueue(queuePath)
    expect(afterFirst.entries).toHaveLength(1)
    expect(afterFirst.entries[0]?.attempts).toBe(1)
    expect((await readArtifactState(statePath)).artifacts[key]).toBeUndefined()

    // After the re-pair the same entry uploads.
    const later = Date.parse(afterFirst.entries[0]?.nextAttemptAt ?? "") + 1
    await runArtifactWorkers(config, deps(sink, later))
    expect((await readQueue(queuePath)).entries).toHaveLength(0)
    expect((await readArtifactState(statePath)).artifacts[key]).toBeDefined()
  })

  test("a 400 is still dropped without retrying: no login fixes a payload the server refuses", async () => {
    const sink = scriptedSink([400])
    await enqueue(queuePath, [entry()])

    await runArtifactWorkers(
      { queuePath, statePath, workers: 1, drainOnce: true },
      deps(sink, 1_800_000_000_000),
    )

    expect((await readQueue(queuePath)).entries).toHaveLength(0)
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
    // A refused payload is an error, not an operational warning: no retry can repair it.
    expect(recorder.error.length).toBeGreaterThan(0)
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

  test("a corrupt queue file is reported with its content and reset, so it stops failing", async () => {
    const corrupt = '{"version":1,"entries":[{"nonsense":true}]}'
    await writeFile(queuePath, corrupt, "utf8")

    await runArtifactWorkers(
      { queuePath, statePath, workers: 3, drainOnce: true },
      deps(scriptedSink([200])),
    )

    const reports = recorder.error.filter((call) =>
      call.message.includes("queue file did not parse"),
    )
    // Three workers, one report: the first reset leaves a file the others parse.
    expect(reports).toHaveLength(1)
    expect(reports[0]?.details).toMatchObject({ path: queuePath, content: corrupt })
    expect(await readQueue(queuePath)).toEqual({ version: 1, entries: [] })
  })

  test("malformed JSON is reported too, not read as an absent file", async () => {
    await writeFile(queuePath, "{ this is not json", "utf8")

    await runArtifactWorkers(
      { queuePath, statePath, workers: 1, drainOnce: true },
      deps(scriptedSink([200])),
    )

    expect(
      recorder.error.filter((call) => call.message.includes("queue file did not parse")),
    ).toHaveLength(1)
  })

  test("a queue file that is merely absent is not reported", async () => {
    await runArtifactWorkers(
      { queuePath, statePath, workers: 1, drainOnce: true },
      deps(scriptedSink([200])),
    )

    expect(recorder.error).toHaveLength(0)
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
    const target = entry({ created: false, base: "base bytes\n" })
    await enqueue(queuePath, [target])

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

  test("S9: an artifact is scanned when its own classified type is html or markdown", async () => {
    // Driven by the extension the upload classifies from, so every markup extension the MIME map
    // knows is scanned and nothing else is -- the two lists cannot drift apart.
    const scanned = { md: "doc.md", markdown: "doc.markdown", html: "doc.html", htm: "doc.htm" }
    const skipped = { txt: "doc.txt", ts: "doc.ts", png: "doc.png" }

    const targetOf = (key: string) => join(dir, `target-${key}.dat`)
    const all = { ...scanned, ...skipped }
    await Promise.all(
      Object.keys(all).map((key) => writeFile(targetOf(key), "target bytes", "utf8")),
    )

    let session = 0
    for (const [key, name] of Object.entries(all)) {
      const doc = join(dir, name)
      const body = `href="target-${key}.dat"`
      // The png is binary, so it must be skipped on encoding even though its body would match.
      await writeFile(
        doc,
        key === "png" ? Buffer.concat([Buffer.from(body), Buffer.from([0])]) : body,
      )
      session += 1
      await enqueue(queuePath, [
        entry({ path: doc, relativePath: name, sessionId: `s-${session}` }),
      ])
    }

    const sink = scriptedSink([200])
    await runArtifactWorkers({ queuePath, statePath, workers: 1, drainOnce: true }, deps(sink))

    const sentPaths = new Set(sink.sent.map((payload) => payload.path))
    for (const key of Object.keys(scanned))
      expect([key, sentPaths.has(targetOf(key))]).toEqual([key, true])
    for (const key of Object.keys(skipped))
      expect([key, sentPaths.has(targetOf(key))]).toEqual([key, false])
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

  test("S14: a tracked reference is rejected while its untracked sibling is kept", async () => {
    const reportPath = join(dir, "notes.md")
    await mkdir(join(dir, "src"), { recursive: true })
    await mkdir(join(dir, "clips"), { recursive: true })
    await writeFile(join(dir, "src", "driver.ts"), "export const x = 1", "utf8")
    await writeFile(join(dir, "clips", "run.mp4"), "video bytes", "utf8")
    await writeFile(
      reportPath,
      '<img src="src/driver.ts"><video src="clips/run.mp4"></video>',
      "utf8",
    )

    await enqueue(queuePath, [entry({ path: reportPath, relativePath: "notes.md" })])
    const sink = scriptedSink([200])
    gitTracking(["src/driver.ts"])

    await runArtifactWorkers({ queuePath, statePath, workers: 1, drainOnce: true }, deps(sink))

    const sent = sink.sent.map((payload) => payload.path)
    expect(sent).toContain(join(dir, "clips", "run.mp4"))
    expect(sent).not.toContain(join(dir, "src", "driver.ts"))
  })

  test("S15: classification is one git call carrying the whole reference set", async () => {
    const reportPath = join(dir, "notes.md")
    for (const name of ["a.png", "b.png", "c.png", "d.png"]) {
      await writeFile(join(dir, name), `${name} bytes`, "utf8")
    }
    await writeFile(
      reportPath,
      ["a.png", "b.png", "c.png", "d.png"].map((name) => `<img src="${name}">`).join("\n"),
      "utf8",
    )

    await enqueue(queuePath, [entry({ path: reportPath, relativePath: "notes.md" })])
    gitTracking([])

    await runArtifactWorkers(
      { queuePath, statePath, workers: 1, drainOnce: true },
      deps(scriptedSink([200])),
    )

    expect(lsFilesArgs()).toHaveLength(1)
    expect(lsFilesArgs()[0]).toEqual(expect.arrayContaining(["a.png", "b.png", "c.png", "d.png"]))
    expect(git.mock.calls[0]?.[1]).toBe(dir)
  })

  test("S16: the git invocation disables pathspec magic", async () => {
    const reportPath = join(dir, "notes.md")
    await writeFile(join(dir, "shot[1].png"), "shot bytes", "utf8")
    await writeFile(reportPath, '<img src="shot[1].png">', "utf8")

    await enqueue(queuePath, [entry({ path: reportPath, relativePath: "notes.md" })])
    const sink = scriptedSink([200])
    gitTracking([])

    await runArtifactWorkers({ queuePath, statePath, workers: 1, drainOnce: true }, deps(sink))

    // A top-level git option: after the subcommand git rejects it as unknown.
    expect(lsFilesArgs()[0]?.slice(0, 4)).toEqual(["--literal-pathspecs", "ls-files", "-z", "--"])
    expect(sink.sent.map((payload) => payload.path)).toContain(join(dir, "shot[1].png"))
  })

  test("S17: tracked-ness is matched by identity, not by position", async () => {
    const reportPath = join(dir, "notes.md")
    for (const name of ["a.png", "b.png", "c.png"]) {
      await writeFile(join(dir, name), `${name} bytes`, "utf8")
    }
    await writeFile(
      reportPath,
      ["a.png", "b.png", "c.png"].map((name) => `<img src="${name}">`).join("\n"),
      "utf8",
    )

    await enqueue(queuePath, [entry({ path: reportPath, relativePath: "notes.md" })])
    const sink = scriptedSink([200])
    // Git answers with only the third path, and in its own order: a positional pairing would
    // discard `a.png` instead.
    gitTracking(["c.png"])

    await runArtifactWorkers({ queuePath, statePath, workers: 1, drainOnce: true }, deps(sink))

    const sent = sink.sent.map((payload) => payload.path)
    expect(sent).toContain(join(dir, "a.png"))
    expect(sent).toContain(join(dir, "b.png"))
    expect(sent).not.toContain(join(dir, "c.png"))
  })

  test("S18: a git failure drops every reference for that document", async () => {
    const reportPath = join(dir, "notes.md")
    await writeFile(join(dir, "a.png"), "a bytes", "utf8")
    await writeFile(join(dir, "b.png"), "b bytes", "utf8")
    await writeFile(reportPath, '<img src="a.png"><img src="b.png">', "utf8")

    const report = entry({ path: reportPath, relativePath: "notes.md" })
    await enqueue(queuePath, [report])
    const sink = scriptedSink([200])
    gitTracking(null)

    await runArtifactWorkers({ queuePath, statePath, workers: 1, drainOnce: true }, deps(sink))

    expect(sink.sent.map((payload) => payload.path)).toEqual([reportPath])
    // The document's own upload still succeeded -- a scan failure never undoes it.
    const state = await readArtifactState(statePath)
    expect(state.artifacts[stateKey(report.sessionId, reportPath)]?.currentHash).toBeDefined()
  })

  test("S19: an out-of-root reference never reaches git", async () => {
    const reportPath = join(dir, "pages", "report.md")
    await mkdir(dirname(reportPath), { recursive: true })
    await writeFile(join(dirname(dir), "outside.png"), "outside bytes", "utf8")
    await writeFile(join(dir, "pages", "inside.mp4"), "video bytes", "utf8")
    await writeFile(
      reportPath,
      '<img src="../../outside.png"><video src="inside.mp4"></video>',
      "utf8",
    )

    await enqueue(queuePath, [entry({ path: reportPath, relativePath: "pages/report.md" })])
    const sink = scriptedSink([200])
    gitTracking([])

    await runArtifactWorkers({ queuePath, statePath, workers: 1, drainOnce: true }, deps(sink))

    // One escaping path makes the real `git ls-files` exit 128 and print nothing for the batch.
    const passed = (git.mock.calls[0]?.[0] ?? []).filter(
      (arg) => !arg.startsWith("-") && arg !== "--",
    )
    expect(passed.some((arg) => arg.startsWith(".."))).toBe(false)
    expect(sink.sent.map((payload) => payload.path)).toContain(join(dir, "pages", "inside.mp4"))
  })

  test("S21: a project that is not a git repo keeps every reference", async () => {
    const reportPath = join(dir, "notes.md")
    await writeFile(join(dir, "a.png"), "a bytes", "utf8")
    await writeFile(join(dir, "b.png"), "b bytes", "utf8")
    await writeFile(reportPath, '<img src="a.png"><img src="b.png">', "utf8")

    await enqueue(queuePath, [entry({ path: reportPath, relativePath: "notes.md" })])
    const sink = scriptedSink([200])
    gitNotARepo()

    await runArtifactWorkers({ queuePath, statePath, workers: 1, drainOnce: true }, deps(sink))

    // Nothing can be tracked outside a repo, so the tracked filter has nothing to exclude.
    expect(sink.sent.map((payload) => payload.path).sort()).toEqual(
      [reportPath, join(dir, "a.png"), join(dir, "b.png")].sort(),
    )
  })

  test("S20: a scratch document's references are measured against the carried project root", async () => {
    const scratch = await realpath(tmpdir())
    const reportPath = join(scratch, `samskara-report-${randomUUID()}.md`)
    const sibling = join(scratch, `samskara-sibling-${randomUUID()}.png`)
    const inProject = join(dir, "clips", "run.mp4")

    await mkdir(dirname(inProject), { recursive: true })
    await writeFile(inProject, "video bytes", "utf8")
    await writeFile(sibling, "sibling bytes", "utf8")
    await writeFile(reportPath, `![a](${inProject})\n![b](${sibling})\n`, "utf8")

    // Without the carried root, subtraction would yield the scratch root and the sibling would
    // sit "inside the project", which is the whole reason the field exists.
    await enqueue(queuePath, [
      entry({
        path: reportPath,
        relativePath: basename(reportPath),
        projectRoot: dir,
        sessionId: "scratch-session",
      }),
    ])

    const sink = scriptedSink([200])
    await runArtifactWorkers({ queuePath, statePath, workers: 1, drainOnce: true }, deps(sink))

    const paths = sink.sent.map((payload) => payload.path)
    expect(paths).toContain(inProject)
    expect(paths).not.toContain(sibling)

    await rm(reportPath, { force: true })
    await rm(sibling, { force: true })
  })

  test("a symlink inside the project root pointing outside it is never captured", async () => {
    const reportPath = join(dir, "notes.md")
    await mkdir(join(dir, "assets"), { recursive: true })
    const secretPath = join(dirname(dir), "secret.txt")
    await writeFile(secretPath, "outside bytes", "utf8")
    await symlink(secretPath, join(dir, "assets", "logo.png"))
    await writeFile(reportPath, '<img src="assets/logo.png">', "utf8")

    await enqueue(queuePath, [entry({ path: reportPath, relativePath: "notes.md" })])
    const sink = scriptedSink([200])
    gitTracking([])

    await runArtifactWorkers({ queuePath, statePath, workers: 1, drainOnce: true }, deps(sink))

    expect(sink.sent.map((payload) => payload.path)).toEqual([reportPath])
  })

  test("a symlink inside the project root to a file inside it is captured under its real path", async () => {
    const reportPath = join(dir, "notes.md")
    await mkdir(join(dir, "assets"), { recursive: true })
    await mkdir(join(dir, "clips"), { recursive: true })
    await writeFile(join(dir, "clips", "run.mp4"), "video bytes", "utf8")
    await symlink(join(dir, "clips", "run.mp4"), join(dir, "assets", "link.mp4"))
    await writeFile(reportPath, '<video src="assets/link.mp4"></video>', "utf8")

    await enqueue(queuePath, [entry({ path: reportPath, relativePath: "notes.md" })])
    const sink = scriptedSink([200])
    gitTracking([])

    await runArtifactWorkers({ queuePath, statePath, workers: 1, drainOnce: true }, deps(sink))

    const sent = sink.sent.map((payload) => payload.path)
    expect(sent).toContain(join(dir, "clips", "run.mp4"))
    expect(sent).not.toContain(join(dir, "assets", "link.mp4"))
  })

  test("a scan-body exception is caught and never turns a succeeded upload into a retry", async () => {
    // Two documents, both due: if the catch inside the scan ever bubbled up instead of staying
    // local, `processOne` would throw, the outer `runWorker` catch would swallow it and report
    // `worked: false`, and `drainOnce` would return before the second entry was ever claimed --
    // a silent stall the single-entry version of this test could not observe.
    const firstPath = join(dir, "notes.md")
    const secondPath = join(dir, "notes2.md")
    await writeFile(join(dir, "a.png"), "a bytes", "utf8")
    await writeFile(join(dir, "b.png"), "b bytes", "utf8")
    await writeFile(firstPath, '<img src="a.png">', "utf8")
    await writeFile(secondPath, '<img src="b.png">', "utf8")

    const first = entry({ path: firstPath, relativePath: "notes.md" })
    const second = entry({ path: secondPath, relativePath: "notes2.md" })
    await enqueue(queuePath, [first, second])
    const sink = scriptedSink([200])
    git.mockImplementation(async () => {
      throw new Error("boom")
    })

    await runArtifactWorkers({ queuePath, statePath, workers: 1, drainOnce: true }, deps(sink))

    expect(sink.sent.map((payload) => payload.path).sort()).toEqual([firstPath, secondPath].sort())
    const state = await readArtifactState(statePath)
    expect(state.artifacts[stateKey(first.sessionId, firstPath)]?.currentHash).toBeDefined()
    expect(state.artifacts[stateKey(second.sessionId, secondPath)]?.currentHash).toBeDefined()
    expect((await readQueue(queuePath)).entries).toHaveLength(0)
    expect(recorder.warn.length).toBeGreaterThanOrEqual(2)
  })

  test("A1: a verification report seeds its own generated media and nothing from the repo", async () => {
    const reportPath = join(dir, "verification", "proof-report.html")
    await mkdir(dirname(reportPath), { recursive: true })
    await mkdir(join(dir, "src"), { recursive: true })
    await writeFile(join(dir, "verification", "run.mp4"), "video bytes", "utf8")
    await writeFile(join(dir, "verification", "shot.png"), "shot bytes", "utf8")
    await writeFile(join(dir, "src", "driver.ts"), "export const x = 1", "utf8")
    await writeFile(join(dirname(dir), "outside.png"), "outside bytes", "utf8")
    await writeFile(
      reportPath,
      [
        '<video src="run.mp4" poster="shot.png"></video>',
        '<a href="../src/driver.ts">source</a>',
        '<img src="https://example.com/remote.png">',
        '<img src="../../outside.png">',
      ].join("\n"),
      "utf8",
    )

    const report = entry({
      path: reportPath,
      relativePath: "verification/proof-report.html",
      sessionId: "proof-session",
    })
    await enqueue(queuePath, [report])

    const sink = scriptedSink([200])
    gitTracking(["src/driver.ts"])
    const config = { queuePath, statePath, workers: 1, drainOnce: true }

    for (let pass = 0; pass < 4; pass += 1) {
      await runArtifactWorkers(config, deps(sink))
    }

    const sent = sink.sent.map((payload) => payload.path)
    expect(sent).toContain(join(dir, "verification", "run.mp4"))
    expect(sent).toContain(join(dir, "verification", "shot.png"))
    expect(sent).not.toContain(join(dir, "src", "driver.ts"))
    expect(sent.some((path) => path.includes("outside.png"))).toBe(false)
    expect(sent.some((path) => path.includes("remote.png"))).toBe(false)

    for (const payload of sink.sent) {
      if (payload.path === reportPath) continue
      expect(payload.sessionId).toBe(report.sessionId)
      expect(payload.changeKind).toBe("created")
    }

    expect((await readQueue(queuePath)).entries).toHaveLength(0)
    expect(new Set(sent).size).toBe(sent.length)
  })

  test("SC9 (regression): a vanished file settles at debug and an oversize file settles at warn", async () => {
    const sink = scriptedSink([200])

    const vanished = entry({ path: join(dir, "gone.md") })
    await enqueue(queuePath, [vanished])
    await runArtifactWorkers({ queuePath, statePath, workers: 1, drainOnce: true }, deps(sink))
    expect(sink.sent).toHaveLength(0)
    expect((await readQueue(queuePath)).entries).toHaveLength(0)
    expect(recorder.debug.some((call) => call.details.path === vanished.path)).toBe(true)
    expect(recorder.warn).toHaveLength(0)

    const bigPath = join(dir, "big.md")
    await writeFile(bigPath, "a".repeat(5 * 1024 * 1024 + 1), "utf8")
    const oversize = entry({ path: bigPath, relativePath: "big.md", sessionId: "sess-big" })
    await enqueue(queuePath, [oversize])
    await runArtifactWorkers({ queuePath, statePath, workers: 1, drainOnce: true }, deps(sink))
    expect(sink.sent).toHaveLength(0)
    expect((await readQueue(queuePath)).entries).toHaveLength(0)
    expect(recorder.warn.some((call) => call.details.path === bigPath)).toBe(true)
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

  test("SC13: a queued artifact carries the server it's queued for through to a real upload", async () => {
    await writeSettings({ apiUrl: "https://one.example", webUrl: "https://one.example" })
    const target = entry()
    await enqueue(queuePath, [target])
    expect((await readQueue(queuePath)).apiBase).toBe("https://one.example")

    const sink = scriptedSink([200])
    await runArtifactWorkers({ queuePath, statePath, workers: 1, drainOnce: true }, deps(sink))

    expect(sink.sent).toHaveLength(1)
    expect((await readQueue(queuePath)).entries).toHaveLength(0)
    expect((await readArtifactState(statePath)).apiBase).toBe("https://one.example")
  })
})

describe("artifact state", () => {
  const originalHome = process.env.SAMSKARA_HOME
  let statePath: string

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), "samskara-artstate-"))
    statePath = join(dir, "artifacts.json")
    process.env.SAMSKARA_HOME = dir
  })

  afterEach(() => {
    process.env.SAMSKARA_HOME = originalHome
  })

  test("SC12: an artifact upload records the server it landed on", async () => {
    await writeSettings({ apiUrl: "https://one.example", webUrl: "https://one.example" })
    const key = stateKey("0b9d4c1e-7f3a-4c22-9a6e-1d5f8b2c3e40", "/work/app/a.md")

    await advanceArtifactState(statePath, key, { currentHash: "abc", baseCaptured: true })

    const state = await readArtifactState(statePath)
    expect(state.apiBase).toBe("https://one.example")
    expect(state.artifacts[key]).toEqual({ currentHash: "abc", baseCaptured: true })
  })

  test("S36: a missing state file reads back empty, a corrupt one throws", async () => {
    expect(await readArtifactState(statePath)).toEqual({ version: 1, artifacts: {} })

    await writeFile(statePath, "{not json", "utf8")
    await expect(readArtifactState(statePath)).rejects.toThrow()

    await writeFile(statePath, JSON.stringify({ version: 2, artifacts: {} }), "utf8")
    await expect(readArtifactState(statePath)).rejects.toThrow()
  })

  test("S36: the reset helper absorbs a corrupt state file and repairs it", async () => {
    await writeFile(statePath, "{not json", "utf8")

    expect(await readArtifactStateOrReset(statePath)).toEqual({ version: 1, artifacts: {} })
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
