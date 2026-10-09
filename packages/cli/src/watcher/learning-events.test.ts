import { execFile } from "node:child_process"
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import type { CompoundLearningEvent } from "@samskara/core"
import { afterEach, beforeEach, expect, test } from "vitest"
import type { ProjectEntry } from "../config/projects.js"
import {
  backoffMs,
  type EventSource,
  isBeforeCutoff,
  type LearningEventsDeps,
  listEventSources,
  nodeLearningEventsDeps,
  runLearningEventsStep,
  startLearningEventsTicker,
  worktreeFolders,
} from "./learning-events.js"
import type { SinkResult } from "./sink.js"
import { silentLogger, spyLogger } from "./test-logger.js"

let root: string
let dir: string
let statePath: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "samskara-learning-events-"))
  dir = join(root, "learning-events")
  statePath = join(root, "home", "learning-events.json")
  await mkdir(dir)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const NOW = Date.parse("2026-10-06T12:00:00Z")

const event = (id: string, overrides: Record<string, unknown> = {}) => ({
  event_id: id,
  session_id: "sess-1",
  timestamp: "2026-10-06T11:00:00Z",
  cwd: "/work/repo",
  trigger: "auto",
  why_triggered: "repeated correction",
  proposed_learning: "Prefer absolute paths",
  outcome: "new",
  ...overrides,
})

const line = (value: unknown): string => `${JSON.stringify(value)}\n`

type Harness = {
  readonly deps: LearningEventsDeps
  readonly sent: ReadonlyArray<ReadonlyArray<string>>
  readonly sentEvents: ReadonlyArray<CompoundLearningEvent>
  readonly sourceCalls: { count: number }
  clock: number
}

const harness = (
  over: Partial<LearningEventsDeps> & {
    status?: () => number
    sources?: () => ReadonlyArray<EventSource>
  } = {},
): Harness => {
  const sent: string[][] = []
  const sentEvents: CompoundLearningEvent[] = []
  const sourceCalls = { count: 0 }
  const h: Harness = {
    sent,
    sentEvents,
    sourceCalls,
    clock: NOW,
    deps: undefined as unknown as LearningEventsDeps,
  }
  const base = nodeLearningEventsDeps({
    listSources: async () => {
      sourceCalls.count += 1
      return over.sources?.() ?? [{ dir }]
    },
    hasToken: async () => true,
    send: async (events): Promise<SinkResult> => {
      sent.push(events.map((e) => e.event_id))
      sentEvents.push(...events)
      return { status: over.status?.() ?? 200 }
    },
    apiBase: "http://test",
    log: silentLogger(),
  })
  const { status: _status, sources: _sources, ...rest } = over
  ;(h as { deps: LearningEventsDeps }).deps = { ...base, now: () => h.clock, ...rest }
  return h
}

const run = (deps: LearningEventsDeps) => runLearningEventsStep({ statePath }, deps)

const readState = async () => JSON.parse(await readFile(statePath, "utf8"))

const project = (slug: string, entry: Partial<ProjectEntry>) => ({
  slug,
  entry: {
    name: slug,
    path: `/work/${slug}`,
    enabled: true,
    enabledAt: "2026-10-01T00:00:00.000Z",
    ...entry,
  },
})

const git = promisify(execFile)

test("only lines appended since the last cycle are sent", async () => {
  const file = join(dir, "sess-1.jsonl")
  await writeFile(file, line(event("a")) + line(event("b")))
  const h = harness()

  await run(h.deps)
  await appendFile(file, line(event("c")))
  await run(h.deps)
  await run(h.deps)

  expect(h.sent).toEqual([["a", "b"], ["c"]])
})

test("a half-written last line is held back until its newline arrives", async () => {
  const file = join(dir, "sess-1.jsonl")
  const whole = line(event("b"))
  await writeFile(file, line(event("a")) + whole.slice(0, 20))
  const h = harness()

  await run(h.deps)
  await appendFile(file, whole.slice(20))
  await run(h.deps)

  expect(h.sent).toEqual([["a"], ["b"]])
})

test("every source's files are read, each against its own project's cutoff", async () => {
  const other = join(root, "other-repo", ".yok", "learning-events")
  await mkdir(other, { recursive: true })
  const early = { timestamp: "2026-09-01T00:00:00Z" }
  await writeFile(join(dir, "s.jsonl"), line(event("harness-early", early)))
  await writeFile(join(other, "s.jsonl"), line(event("yok-early", early)))
  const h = harness({
    sources: () => [{ dir, syncFrom: "2026-10-01T00:00:00.000Z" }, { dir: other }],
  })

  await run(h.deps)

  expect(h.sent).toEqual([["yok-early"]])
})

test("events before the project's sync-from cutoff are passed over, later ones are sent", async () => {
  await writeFile(
    join(dir, "s.jsonl"),
    line(event("early", { timestamp: "2026-10-01T09:59:59Z" })) +
      line(event("on-cutoff", { timestamp: "2026-10-01T10:00:00Z" })) +
      line(event("late", { timestamp: "2026-10-02T00:00:00+05:30" })),
  )
  const h = harness({ sources: () => [{ dir, syncFrom: "2026-10-01T10:00:00.000Z" }] })

  await run(h.deps)
  await run(h.deps)

  expect(h.sent).toEqual([["on-cutoff", "late"]])
})

test("a failed upload keeps the checkpoint and backs off exponentially before retrying", async () => {
  const file = join(dir, "s.jsonl")
  await writeFile(file, line(event("a")))
  let status = 500
  const spy = spyLogger()
  const h = harness({ status: () => status, log: spy.log })

  await run(h.deps)
  expect((await readState()).files[file]).toEqual({
    offset: 0,
    failures: 1,
    nextAttemptAt: NOW + 30_000,
  })

  h.clock = NOW + 29_999
  await run(h.deps)
  expect(h.sent).toHaveLength(1)

  h.clock = NOW + 30_000
  await run(h.deps)
  expect((await readState()).files[file]).toMatchObject({
    failures: 2,
    nextAttemptAt: h.clock + 60_000,
  })

  status = 200
  h.clock += 60_000
  await run(h.deps)
  expect(h.sent).toEqual([["a"], ["a"], ["a"]])
  expect((await readState()).files[file]).toEqual({ offset: (await stat(file)).size })
  expect(spy.warn.map((c) => c.message)).toContain("Learning events upload failed; will retry")
})

test("backoff doubles from 30 seconds and stops at an hour", () => {
  expect([1, 2, 3, 8, 20].map(backoffMs)).toEqual([30_000, 60_000, 120_000, 3_600_000, 3_600_000])
})

test("a 401 stops the step for this cycle without backing off or touching other files", async () => {
  await writeFile(join(dir, "a.jsonl"), line(event("a")))
  await writeFile(join(dir, "b.jsonl"), line(event("b")))
  const h = harness({ status: () => 401 })

  await run(h.deps)

  expect(h.sent).toEqual([["a"]])
  const state = await readState()
  expect(state.files[join(dir, "a.jsonl")]).toEqual({ offset: 0 })
  expect(state.files[join(dir, "b.jsonl")]).toBeUndefined()
})

test("more than one batch is split at the cap", async () => {
  const lines = Array.from({ length: 501 }, (_, i) => line(event(`e${i}`))).join("")
  await writeFile(join(dir, "s.jsonl"), lines)
  const h = harness()

  await run(h.deps)

  expect(h.sent.map((batch) => batch.length)).toEqual([500, 1])
})

test("lines that are not JSON are logged with their byte offset, skipped, and never retried", async () => {
  const file = join(dir, "s.jsonl")
  await writeFile(file, `{oops\n${line(event("ok"))}`)
  const spy = spyLogger()
  const h = harness({ log: spy.log })

  await run(h.deps)
  await appendFile(file, `also bad\n`)
  await run(h.deps)
  await run(h.deps)

  expect(h.sent).toEqual([["ok"]])
  const malformed = spy.warn.filter((c) => c.message === "Skipping malformed learning event")
  expect(malformed.map((c) => c.details.byteOffset)).toEqual([0, 6 + line(event("ok")).length])
  expect((await readState()).files[file]).toEqual({ offset: (await stat(file)).size })
})

test("an event this CLI does not understand holds the file there, for a newer CLI to upload", async () => {
  const file = join(dir, "s.jsonl")
  const before = line(event("a"))
  await writeFile(file, before + line(event("newer", { outcome: "merged" })) + line(event("after")))
  const spy = spyLogger()
  const h = harness({ log: spy.log })

  await run(h.deps)
  await run(h.deps)

  expect(h.sent).toEqual([["a"]])
  expect((await readState()).files[file]).toEqual({ offset: Buffer.byteLength(before) })
  expect(spy.warn.map((c) => c.details.byteOffset)).toContain(Buffer.byteLength(before))
})

test("offsets are raw bytes: multi-byte text split across a checkpoint survives intact", async () => {
  const file = join(dir, "s.jsonl")
  const first = Buffer.from(line(event("a", { proposed_learning: "café 😀 first" })), "utf8")
  const second = Buffer.from(line(event("b", { proposed_learning: "naïve 😀😀 second" })), "utf8")
  const emojiAt = second.indexOf(Buffer.from("😀", "utf8"))
  await writeFile(file, Buffer.concat([first, second.subarray(0, emojiAt + 2)]))
  const h = harness()

  await run(h.deps)
  expect((await readState()).files[file].offset).toBe(first.length)

  await appendFile(file, second.subarray(emojiAt + 2))
  await run(h.deps)

  expect(h.sentEvents.map((e) => e.proposed_learning)).toEqual([
    "café 😀 first",
    "naïve 😀😀 second",
  ])
  expect((await readState()).files[file].offset).toBe(first.length + second.length)
})

test("a line with an invalid UTF-8 byte is malformed, and the offset still lands on the byte", async () => {
  const file = join(dir, "s.jsonl")
  const bad = Buffer.concat([
    Buffer.from('{"event_id":"bad","proposed_learning":"x', "utf8"),
    Buffer.from([0xff]),
    Buffer.from('"}\n', "utf8"),
  ])
  await writeFile(
    file,
    Buffer.concat([bad, Buffer.from(line(event("ok", { proposed_learning: "é" })))]),
  )
  const spy = spyLogger()
  const h = harness({ log: spy.log })

  await run(h.deps)

  expect(h.sent).toEqual([["ok"]])
  expect(spy.warn.find((c) => c.details.byteOffset === 0)?.details.reason).toBe("not valid UTF-8")
  expect((await readState()).files[file].offset).toBe((await stat(file)).size)
})

test("state entries for files that no longer exist are pruned", async () => {
  await writeFile(join(dir, "keep.jsonl"), line(event("a")))
  await writeFile(join(dir, "gone.jsonl"), line(event("b")))
  const h = harness()
  await run(h.deps)

  await rm(join(dir, "gone.jsonl"))
  await run(h.deps)

  expect(Object.keys((await readState()).files)).toEqual([join(dir, "keep.jsonl")])
})

test("checkpoints persist in the state file across runs, stamped with the server", async () => {
  await writeFile(join(dir, "s.jsonl"), line(event("a")))
  await run(harness().deps)

  const second = harness()
  await run(second.deps)

  expect(second.sent).toEqual([])
  const state = await readState()
  expect(state.apiBase).toBe("http://test")
  expect(Object.values(state.files)).toEqual([{ offset: line(event("a")).length }])
})

test("a file that shrank is read again from the start", async () => {
  const file = join(dir, "s.jsonl")
  await writeFile(file, line(event("a")) + line(event("b")))
  const h = harness()
  await run(h.deps)

  await writeFile(file, line(event("c")))
  await run(h.deps)

  expect(h.sent).toEqual([["a", "b"], ["c"]])
})

test("no events directory is a silent no-op that writes no state", async () => {
  await rm(dir, { recursive: true })
  const spy = spyLogger()
  const h = harness({ log: spy.log })

  await run(h.deps)

  expect(h.sent).toEqual([])
  expect(spy.warn).toEqual([])
  expect(spy.error).toEqual([])
  await expect(readFile(statePath, "utf8")).rejects.toThrow()
})

test("without a stored login nothing is read or sent", async () => {
  await writeFile(join(dir, "s.jsonl"), line(event("a")))
  const h = harness({ hasToken: async () => false })

  await run(h.deps)

  expect(h.sent).toEqual([])
  expect(h.sourceCalls.count).toBe(0)
})

test("the ticker isolates a failing step and never runs two at once", async () => {
  const spy = spyLogger()
  let calls = 0
  let release: () => void = () => {}
  const tick = startLearningEventsTicker(() => {
    calls += 1
    if (calls === 1) return Promise.reject(new Error("boom"))
    return new Promise<void>((resolve) => {
      release = resolve
    })
  }, spy.log)

  tick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(spy.error.map((c) => c.message)).toEqual(["Learning events step failed"])

  tick()
  tick()
  expect(calls).toBe(2)
  release()
  await new Promise((resolve) => setTimeout(resolve, 0))
  tick()
  expect(calls).toBe(3)
})

test("sources are the event folders of enabled projects' checkouts, each listed once", async () => {
  const projects = [
    project("on", { syncFrom: "2026-10-01T00:00:00.000Z" }),
    project("off", { enabled: false }),
    project("shared", { path: "/work/on", syncFrom: "2026-10-01T00:00:00.000Z" }),
  ]
  const foldersOf = async (path: string) =>
    path === "/work/on" ? ["/work/on", "/work/on.feat-x"] : [path]

  const sources = await listEventSources(projects, foldersOf)

  const cutoff = "2026-10-01T00:00:00.000Z"
  expect(sources).toEqual([
    { dir: "/work/on/.harness/learning-events", syncFrom: cutoff },
    { dir: "/work/on/.yok/learning-events", syncFrom: cutoff },
    { dir: "/work/on.feat-x/.harness/learning-events", syncFrom: cutoff },
    { dir: "/work/on.feat-x/.yok/learning-events", syncFrom: cutoff },
  ])
})

test("when two projects share a checkout, the stricter (later) cutoff wins", async () => {
  const projects = [
    project("early", { path: "/work/repo", syncFrom: "2026-01-01T00:00:00.000Z" }),
    project("late", { path: "/work/repo", syncFrom: "2026-06-01T00:00:00.000Z" }),
  ]

  const sources = await listEventSources(projects, async (path) => [path])

  expect(sources.map(({ syncFrom }) => syncFrom)).toEqual([
    "2026-06-01T00:00:00.000Z",
    "2026-06-01T00:00:00.000Z",
  ])
})

test("a worktree registered on its own and disabled is not read through its enabled repo", async () => {
  const projects = [project("on", {}), project("off", { path: "/work/on.feat-x", enabled: false })]
  const foldersOf = async () => ["/work/on", "/work/on.feat-x"]

  const dirs = (await listEventSources(projects, foldersOf)).map(({ dir }) => dir)

  expect(dirs).toEqual(["/work/on/.harness/learning-events", "/work/on/.yok/learning-events"])
})

test("a repo's checkouts are the folder itself and every worktree git knows of", async () => {
  const repo = await realpath(await mkdtemp(join(tmpdir(), "samskara-repo-")))
  const tree = `${repo}.feat-x`
  try {
    await git("git", ["init", "-q"], { cwd: repo })
    await git(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"],
      { cwd: repo },
    )
    await git("git", ["worktree", "add", "-q", tree], { cwd: repo })
    const plain = join(root, "plain")
    await mkdir(plain)

    expect(await worktreeFolders(repo)).toEqual([repo, tree])
    expect(await worktreeFolders(plain)).toEqual([await realpath(plain)])
  } finally {
    await rm(tree, { recursive: true, force: true })
    await rm(repo, { recursive: true, force: true })
  }
})

test("an event is before the cutoff only when there is one and its timestamp is earlier", () => {
  const e = (timestamp: string) =>
    ({ ...event("x"), timestamp }) as unknown as CompoundLearningEvent

  expect(isBeforeCutoff(e("2026-09-30T23:59:59Z"), "2026-10-01T00:00:00Z")).toBe(true)
  expect(isBeforeCutoff(e("2026-10-01T00:00:00Z"), "2026-10-01T00:00:00Z")).toBe(false)
  expect(isBeforeCutoff(e("2020-01-01T00:00:00Z"))).toBe(false)
})
