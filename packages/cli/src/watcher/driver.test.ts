import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import {
  createClaudePlugin,
  createLogger,
  type FileSystem,
  type NormalizedMessage,
  type ParsedRecord,
  type ProjectIdentity,
  readCheckpoints,
} from "@samskara/core"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { projectsPath, statePath as scopedStatePath } from "../config/paths.js"
import { ALL_SCOPED_PATHS, scopeMismatch } from "../config/server-scope.js"
import { writeSettings } from "../config/settings.js"
import { DEFAULT_MESSAGE_CAP, DEFAULT_SESSION_CONCURRENCY } from "../config.js"
import { enqueue } from "./artifact-queue.js"
import { runArtifactWorkers } from "./artifact-worker.js"
import {
  flushCause,
  runCycle,
  sliceByMessages,
  type WatcherConfig,
  type WatcherDeps,
} from "./driver.js"
import type { ResolvedRepo } from "./resolveRepo.js"
import { createInMemorySink } from "./sink.js"
import { spyLogger } from "./test-logger.js"

// The driver binds these at module load, so the mock must replace the module, not a dep.
const repoMocks = vi.hoisted(() => ({
  resolveRepo: vi.fn<(cwd: string) => Promise<ResolvedRepo | null>>(async () => null),
  resolveHead: vi.fn<(cwd: string) => Promise<string | null>>(async () => null),
}))

vi.mock("./resolveRepo.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createRepoResolver: () => repoMocks.resolveRepo,
  resolveHeadSha: repoMocks.resolveHead,
}))

const nodeFs: FileSystem = {
  readFile: (path) => readFile(path, "utf8"),
  writeFile: (path, data) => writeFile(path, data, "utf8"),
  rename,
  stat: async (path) => {
    const s = await stat(path)
    return { size: s.size, mtimeMs: s.mtimeMs }
  },
}

const project: ProjectIdentity = { name: "widget", slug: "acme-widget" }

const assistantLine = (uuid: string, sessionId: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    uuid,
    sessionId,
    cwd: "/work/app",
    gitBranch: "main",
    timestamp: "2026-07-23T00:00:00.000Z",
    message: {
      role: "assistant",
      model: "claude-opus-4-8",
      content: [
        { type: "text", text: "hi" },
        { type: "tool_use", id: `toolu_${uuid}`, name: "Read", input: {} },
      ],
    },
    ...extra,
  })

const record = (lineNumber: number, messageCount: number): ParsedRecord => {
  const messages = Array.from({ length: messageCount }, (_, subIndex) => ({
    subIndex,
    sessionId: "s",
    source: "claude_code" as const,
    sourceSchemaVersion: 1,
    trackId: "main",
    msgType: "custom" as const,
    subType: "fixture",
  }))
  const [first, ...rest] = messages
  if (!first) throw new Error("record fixtures require at least one message")
  return {
    lineUuid: `00000000-0000-5000-8000-${lineNumber.toString().padStart(12, "0")}`,
    lineNumber,
    raw: {},
    messages: [first, ...rest],
  }
}

describe("sliceByMessages", () => {
  test("keeps everything in one chunk under the cap", () => {
    const chunks = sliceByMessages([record(1, 2), record(2, 3)], 10)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.lastCompleteLine).toBe(2)
    expect(chunks[0]?.records.flatMap((r) => r.messages)).toHaveLength(5)
  })

  test("splits on the cap at a line boundary", () => {
    const chunks = sliceByMessages([record(1, 2), record(2, 2), record(3, 2)], 4)
    expect(chunks).toHaveLength(2)
    expect(chunks[0]?.lastCompleteLine).toBe(2)
    expect(chunks[1]?.lastCompleteLine).toBe(3)
  })

  test("S6: a 1,999-message record plus two-message record and one oversize record remain line atomic", () => {
    const boundaryChunks = sliceByMessages([record(1, 1999), record(2, 2)], DEFAULT_MESSAGE_CAP)
    expect(
      boundaryChunks.map((chunk) => chunk.records.flatMap((item) => item.messages).length),
    ).toEqual([1999, 2])
    expect(boundaryChunks.flatMap((chunk) => chunk.records).map((item) => item.lineNumber)).toEqual(
      [1, 2],
    )

    const oversizeChunks = sliceByMessages([record(3, 2500)], DEFAULT_MESSAGE_CAP)
    expect(oversizeChunks).toHaveLength(1)
    expect(oversizeChunks[0]?.records[0]?.messages).toHaveLength(2500)
    expect(oversizeChunks[0]?.lastCompleteLine).toBe(3)
  })
})

describe("ingest fan-out budget", () => {
  /**
   * Chunks within a session are serial and sessions are capped, so this product is every message
   * the CLI can have in flight at once. 2000 is what a single session was already allowed to send,
   * so the bounded fan-out never puts more on the wire than one unbounded session used to.
   */
  test("the whole cycle never has more messages in flight than one session used to send", () => {
    expect(DEFAULT_SESSION_CONCURRENCY * DEFAULT_MESSAGE_CAP).toBeLessThanOrEqual(2000)
  })
})

describe("flushCause", () => {
  test("SC44 (revised): a 403 points at reassign, not enable - a pinned folder is exactly the folder that gets a 403, and `enable` will not move a pin", () => {
    expect(flushCause(403)).toContain("samskara reassign")
    expect(flushCause(401)).toContain("samskara login")
  })
})

describe("watcher driver", () => {
  const originalHome = process.env.SAMSKARA_HOME
  let dir: string
  let projects: string
  let config: WatcherConfig

  const deps = (over: Partial<WatcherDeps> = {}): WatcherDeps => ({
    fs: nodeFs,
    clock: { now: () => 0 },
    sink: createInMemorySink(),
    glob: async () => [],
    plugin: createClaudePlugin(nodeFs),
    resolveProject: async () => project,
    log: createLogger({ service: "samskara-cli-test" }, { level: "silent" }),
    ...over,
  })

  beforeEach(async () => {
    repoMocks.resolveRepo.mockReset()
    repoMocks.resolveHead.mockReset()
    dir = await mkdtemp(join(tmpdir(), "samskara-watch-"))
    // `runCycle` stamps via `persistedApiUrl()`, which reads `config.json` under `SAMSKARA_HOME`.
    process.env.SAMSKARA_HOME = dir
    projects = join(dir, ".claude", "projects", "bucket")
    await mkdir(projects, { recursive: true })
    config = {
      statePath: join(dir, "state.json"),
      messageCap: DEFAULT_MESSAGE_CAP,
      sessionConcurrency: DEFAULT_SESSION_CONCURRENCY,
    }
  })

  afterEach(() => {
    process.env.SAMSKARA_HOME = originalHome
  })

  test("SC11: a completed cycle records the server it uploaded to", async () => {
    const main = join(projects, "sess-1.jsonl")
    await writeFile(main, `${assistantLine("l1", "sess-1")}\n`, "utf8")
    await writeSettings({ apiUrl: "https://one.example", webUrl: "https://one.example" })

    const store = await runCycle(config, deps({ glob: async () => [main] }))
    expect(store.apiBase).toBe("https://one.example")

    const roundTripped = await readCheckpoints(nodeFs, config.statePath)
    expect(roundTripped.apiBase).toBe("https://one.example")
    expect(roundTripped.checkpoints[main]?.lineProcessed).toBe(1)
  })

  test("SC16: the full check spans every scoped file", async () => {
    await writeSettings({ apiUrl: "https://two.example", webUrl: "https://two.example" })
    await writeFile(
      scopedStatePath(),
      JSON.stringify({ apiBase: "https://one.example", checkpoints: {} }),
      "utf8",
    )
    await writeFile(
      projectsPath(),
      JSON.stringify({ version: 1, apiBase: "https://two.example", projects: {} }),
      "utf8",
    )

    await expect(scopeMismatch(ALL_SCOPED_PATHS())).resolves.toEqual([
      { file: scopedStatePath(), recorded: "https://one.example", current: "https://two.example" },
    ])
  })

  test("flushes a grown main file and advances the watermark", async () => {
    const main = join(projects, "sess-1.jsonl")
    await writeFile(main, `${assistantLine("l1", "sess-1")}\n`, "utf8")

    const sink = createInMemorySink()
    const store = await runCycle(config, deps({ sink, glob: async () => [main] }))

    expect(sink.received).toHaveLength(1)
    expect(sink.received[0]?.type).toBe("main")
    expect(sink.received[0]?.records).toHaveLength(1)
    expect(sink.received[0]?.records[0]?.messages).toHaveLength(2)
    expect(store.checkpoints[main]?.lineProcessed).toBe(1)
    // `samskara status` groups sync times by slug, so every checkpoint must carry one.
    expect(store.checkpoints[main]?.projectSlug).toBe(project.slug)
  })

  test("restart resumes from the persisted watermark", async () => {
    const main = join(projects, "sess-1.jsonl")
    await writeFile(main, `${assistantLine("l1", "sess-1")}\n`, "utf8")
    const sink1 = createInMemorySink()
    await runCycle(config, deps({ sink: sink1, glob: async () => [main] }))

    const sink2 = createInMemorySink()
    await runCycle(config, deps({ sink: sink2, glob: async () => [main] }))
    expect(sink2.received).toHaveLength(0)

    await writeFile(
      main,
      `${assistantLine("l1", "sess-1")}\n${assistantLine("l2", "sess-1")}\n`,
      "utf8",
    )
    const sink3 = createInMemorySink()
    await runCycle(config, deps({ sink: sink3, glob: async () => [main] }))
    expect(sink3.received).toHaveLength(1)
    expect(sink3.received[0]?.records.map((item) => item.lineNumber)).toEqual([2])
  })

  test("does not advance the watermark on a 409 and retries next cycle", async () => {
    const sub = join(projects, "sess-1", "subagents", "agent-af66.jsonl")
    await mkdir(join(projects, "sess-1", "subagents"), { recursive: true })
    // The parent's main transcript: it is what names the directory's project.
    await writeFile(join(projects, "sess-1.jsonl"), `${assistantLine("l1", "sess-1")}\n`, "utf8")
    await writeFile(sub, `${assistantLine("s1", "sess-1", { agentId: "af66" })}\n`, "utf8")
    await writeFile(
      sub.replace(/\.jsonl$/, ".meta.json"),
      JSON.stringify({ agentId: "af66" }),
      "utf8",
    )

    const rejecting = createInMemorySink(() => 409)
    const store = await runCycle(config, deps({ sink: rejecting, glob: async () => [sub] }))
    expect(store.checkpoints[sub]).toBeUndefined()

    const accepting = createInMemorySink(() => 200)
    const next = await runCycle(config, deps({ sink: accepting, glob: async () => [sub] }))
    expect(accepting.received).toHaveLength(1)
    expect(next.checkpoints[sub]?.lineProcessed).toBe(1)
  })

  test("processes main before subagent within a session", async () => {
    const main = join(projects, "sess-1.jsonl")
    const sub = join(projects, "sess-1", "subagents", "agent-af66.jsonl")
    await mkdir(join(projects, "sess-1", "subagents"), { recursive: true })
    await writeFile(main, `${assistantLine("l1", "sess-1")}\n`, "utf8")
    await writeFile(sub, `${assistantLine("s1", "sess-1", { agentId: "af66" })}\n`, "utf8")
    await writeFile(
      sub.replace(/\.jsonl$/, ".meta.json"),
      JSON.stringify({ agentId: "af66" }),
      "utf8",
    )

    const sink = createInMemorySink()
    await runCycle(config, deps({ sink, glob: async () => [sub, main] }))
    expect(sink.received.map((p) => p.type)).toEqual(["main", "subagent"])
  })

  test("a torn trailing line is not flushed until completed", async () => {
    const main = join(projects, "sess-1.jsonl")
    await writeFile(
      main,
      `${assistantLine("l1", "sess-1")}\n${assistantLine("l2", "sess-1")}`,
      "utf8",
    )

    const sink = createInMemorySink()
    const store = await runCycle(config, deps({ sink, glob: async () => [main] }))
    expect(sink.received[0]?.records.map((item) => item.lineNumber)).toEqual([1])
    expect(store.checkpoints[main]?.lineProcessed).toBe(1)

    await writeFile(
      main,
      `${assistantLine("l1", "sess-1")}\n${assistantLine("l2", "sess-1")}\n`,
      "utf8",
    )
    const sink2 = createInMemorySink()
    await runCycle(config, deps({ sink: sink2, glob: async () => [main] }))
    expect(sink2.received[0]?.records.map((item) => item.lineNumber)).toEqual([2])
  })

  test("caps a large scan into multiple chunks and reaches the final line", async () => {
    const main = join(projects, "sess-1.jsonl")
    // Each line fans out into 2 messages; 1500 lines → 3000 messages → several chunks at the cap.
    const lines = Array.from({ length: 1500 }, (_, i) => assistantLine(`l${i + 1}`, "sess-1"))
    await writeFile(main, `${lines.join("\n")}\n`, "utf8")

    const sink = createInMemorySink()
    const store = await runCycle(config, deps({ sink, glob: async () => [main] }))
    expect(sink.received.length).toBeGreaterThanOrEqual(2)
    expect(store.checkpoints[main]?.lineProcessed).toBe(1500)
  })

  test("resolves the project from the session cwd and stamps per-message git facts", async () => {
    const main = join(projects, "sess-1.jsonl")
    await writeFile(main, `${assistantLine("l1", "sess-1")}\n`, "utf8")

    const resolved: ProjectIdentity = { name: "andromeda", slug: "refrens-andromeda" }
    const seenCwds: string[] = []
    const sink = createInMemorySink()
    await runCycle(
      config,
      deps({
        sink,
        glob: async () => [main],
        resolveProject: async (startDir) => {
          seenCwds.push(startDir)
          return resolved
        },
      }),
    )

    expect(seenCwds).toEqual(["/work/app"])
    expect(sink.received[0]?.project).toEqual(resolved)
    const msgs = sink.received[0]?.records.flatMap((r) => r.messages) ?? []
    expect(msgs.every((m) => m.gitBranch === "main")).toBe(true)
  })

  test("remembers each transcript directory's project, so a folder that later disappears still syncs", async () => {
    const main = join(projects, "sess-1.jsonl")
    await writeFile(main, `${assistantLine("l1", "sess-1")}\n`, "utf8")

    const store = await runCycle(config, deps({ glob: async () => [main] }))
    expect(store.projects).toEqual({ [projects]: project })

    // The cwd is gone now -- a removed worktree -- so the resolver has no answer. The remembered
    // entry stands in and the session keeps syncing.
    await writeFile(
      main,
      `${assistantLine("l1", "sess-1")}\n${assistantLine("l2", "sess-1")}\n`,
      "utf8",
    )
    const sink = createInMemorySink()
    const next = await runCycle(
      config,
      deps({ sink, glob: async () => [main], resolveProject: async () => null }),
    )

    expect(sink.received[0]?.project).toEqual(project)
    expect(next.projects).toEqual({ [projects]: project })
  })

  test("derives a missing source sessionId from the transcript path", async () => {
    const main = join(projects, "no-session.jsonl")
    const sessionlessLine = JSON.stringify({
      uuid: "l1",
      cwd: "/work/app",
      timestamp: "2026-07-23T00:00:00.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
    })
    await writeFile(main, `${sessionlessLine}\n`, "utf8")

    const sink = createInMemorySink()
    const store = await runCycle(config, deps({ sink, glob: async () => [main] }))

    expect(sink.received).toHaveLength(1)
    expect(sink.received[0]?.sessionId).toBe("no-session")
    expect(store.checkpoints[main]?.lineProcessed).toBe(1)
  })

  test("a 401 flush names the cause and the fix, not a bare 'flush failed'", async () => {
    const main = join(projects, "sess-1.jsonl")
    await writeFile(main, `${assistantLine("l1", "sess-1")}\n`, "utf8")

    const spy = spyLogger()
    const sink = createInMemorySink(
      () => 401,
      () => '{"error":"unauthorized"}',
    )
    await runCycle(config, deps({ sink, glob: async () => [main], log: spy.log }))

    const [entry] = spy.warn
    expect(entry?.message).toContain("samskara login")
    expect(entry?.details.status).toBe(401)
    expect(entry?.details.detail).toContain("unauthorized")
    expect(entry?.details.key).toBe(main)
  })

  test("a 500 flush explains the retry rather than reading as a lost session", async () => {
    const main = join(projects, "sess-1.jsonl")
    await writeFile(main, `${assistantLine("l1", "sess-1")}\n`, "utf8")

    const spy = spyLogger()
    const sink = createInMemorySink(
      () => 500,
      () => "boom",
    )
    await runCycle(config, deps({ sink, glob: async () => [main], log: spy.log }))

    const [entry] = spy.warn
    expect(entry?.message).toMatch(/retr/i)
    expect(entry?.details.detail).toContain("boom")
  })

  test("independent sessions run in parallel; one failing does not block the other", async () => {
    const a = join(projects, "sess-a.jsonl")
    const b = join(projects, "sess-b.jsonl")
    await writeFile(a, `${assistantLine("a1", "sess-a")}\n`, "utf8")
    await writeFile(b, `${assistantLine("b1", "sess-b")}\n`, "utf8")

    const sink = createInMemorySink((p) => (p.sessionId === "sess-a" ? 500 : 200))
    const store = await runCycle(config, deps({ sink, glob: async () => [a, b] }))

    expect(store.checkpoints[a]).toBeUndefined()
    expect(store.checkpoints[b]?.lineProcessed).toBe(1)
  })

  test("a first sync of many sessions never has more than the concurrency cap in flight", async () => {
    const count = 12
    const files = await Promise.all(
      Array.from({ length: count }, async (_, index) => {
        const path = join(projects, `sess-${index}.jsonl`)
        await writeFile(path, `${assistantLine(`u${index}`, `sess-${index}`)}\n`, "utf8")
        return path
      }),
    )

    let inFlight = 0
    let peak = 0
    const sink = {
      send: async () => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 5))
        inFlight -= 1
        return { status: 200 }
      },
    }

    const store = await runCycle(config, deps({ sink, glob: async () => files }))

    expect(peak).toBeLessThanOrEqual(DEFAULT_SESSION_CONCURRENCY)
    expect(peak).toBe(DEFAULT_SESSION_CONCURRENCY)
    // The cap is scheduling only: every session still syncs in the same cycle.
    for (const file of files) expect(store.checkpoints[file]?.lineProcessed).toBe(1)
  })

  describe("repo attribution", () => {
    const serana = {
      host: "github.com",
      owner: "refrens",
      repoName: "serana",
      root: "/work/serana",
    } as const
    const andromeda = { ...serana, repoName: "andromeda", root: "/work/andromeda" }

    const stubRepoResolver = () => {
      repoMocks.resolveRepo.mockImplementation(async (cwd) => {
        if (cwd === "/work/serana") return serana
        if (cwd === "/work/andromeda") return andromeda
        return null
      })
    }

    test("attributes each message to the repo of its own cwd, so one track spanning two checkouts sends two identities", async () => {
      const main = join(projects, "sess-1.jsonl")
      await writeFile(
        main,
        [
          assistantLine("l1", "sess-1", { cwd: "/work/serana" }),
          assistantLine("l2", "sess-1", { cwd: "/work/andromeda" }),
          assistantLine("l3", "sess-1", { cwd: "/private/tmp/scratch" }),
        ]
          .map((line) => `${line}\n`)
          .join(""),
        "utf8",
      )

      const sink = createInMemorySink()
      stubRepoResolver()
      await runCycle(config, deps({ sink, glob: async () => [main] }))

      const sent = sink.received[0]?.records.flatMap((r) => r.messages) ?? []
      expect(sent.map((m) => m.repo?.repoName)).toEqual([
        "serana",
        "serana",
        "andromeda",
        "andromeda",
        undefined,
        undefined,
      ])
      // The `root` the resolver carries is CLI-side only; the wire identity is the four
      // fields the repos table is keyed by.
      expect(sent[0]?.repo).toEqual({
        host: "github.com",
        owner: "refrens",
        repoName: "serana",
      })
    })

    test("captures the session's starting cwd and HEAD once, on the flush that creates it, and never re-reads HEAD on a later flush", async () => {
      const main = join(projects, "sess-1.jsonl")
      await writeFile(main, `${assistantLine("l1", "sess-1", { cwd: "/work/serana" })}\n`, "utf8")

      const heads = [
        "37f31013b7ac0a2e6f4c9d1e5a8b2c7d0e3f4a5b",
        "aaaabbbbccccddddeeeeffff0000111122223333",
      ]
      let headReads = 0
      repoMocks.resolveHead.mockImplementation(async () => heads[headReads++] ?? null)
      stubRepoResolver()

      const sink1 = createInMemorySink()
      await runCycle(config, deps({ sink: sink1, glob: async () => [main] }))
      expect(sink1.received[0]).toMatchObject({
        startCwd: "/work/serana",
        startCommit: heads[0],
      })

      // HEAD moves as the session commits. A second flush must not re-stamp the origin with
      // whatever HEAD has become -- that is the sha the session ended on, not started on.
      await writeFile(
        main,
        `${assistantLine("l1", "sess-1", { cwd: "/work/serana" })}\n${assistantLine("l2", "sess-1", { cwd: "/work/serana" })}\n`,
        "utf8",
      )
      const sink2 = createInMemorySink()
      await runCycle(config, deps({ sink: sink2, glob: async () => [main] }))
      expect(sink2.received[0]).not.toHaveProperty("startCommit")
      expect(headReads).toBe(1)
    })

    test("a subagent flush carries no session origin, so it cannot re-stamp the session it belongs to", async () => {
      const sub = join(projects, "sess-1", "subagents", "agent-af66.jsonl")
      await mkdir(join(projects, "sess-1", "subagents"), { recursive: true })
      // The parent's main transcript: it is what names the directory's project. The subagent ran
      // elsewhere -- that is the point of this test -- so its own cwd must not decide anything.
      await writeFile(join(projects, "sess-1.jsonl"), `${assistantLine("l1", "sess-1")}\n`, "utf8")
      await writeFile(
        sub,
        `${assistantLine("s1", "sess-1", { agentId: "af66", cwd: "/work/serana" })}\n`,
        "utf8",
      )
      await writeFile(
        sub.replace(/\.jsonl$/, ".meta.json"),
        JSON.stringify({ agentId: "af66" }),
        "utf8",
      )

      const sink = createInMemorySink()
      stubRepoResolver()
      repoMocks.resolveHead.mockImplementation(
        async () => "37f31013b7ac0a2e6f4c9d1e5a8b2c7d0e3f4a5b",
      )
      await runCycle(config, deps({ sink, glob: async () => [sub] }))

      const payload = sink.received[0]
      expect(payload?.type).toBe("subagent")
      expect(payload).not.toHaveProperty("startCwd")
      expect(payload).not.toHaveProperty("startCommit")
      expect(payload?.records[0]?.messages[0]?.repo?.repoName).toBe("serana")
    })

    test("S13c: a git commit run in a sub-repo rides out on the payload carrying that sub-repo's identity", async () => {
      const main = join(projects, "sess-1.jsonl")
      const bashCall = JSON.stringify({
        uuid: "c1",
        sessionId: "sess-1",
        cwd: "/work/serana",
        timestamp: "2026-07-23T00:00:00.000Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_commit",
              name: "Bash",
              input: { command: "git commit -m 'feat: sub-repo work'" },
            },
          ],
        },
      })
      const bashResult = JSON.stringify({
        uuid: "c2",
        sessionId: "sess-1",
        cwd: "/work/serana",
        timestamp: "2026-07-23T00:00:01.000Z",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_commit",
              content:
                "[feat/local-source-graph 2314a2e44] feat: sub-repo work\n 3 files changed, 8 insertions(+), 2 deletions(-)",
            },
          ],
        },
      })
      await writeFile(main, `${bashCall}\n${bashResult}\n`, "utf8")

      const sink = createInMemorySink()
      stubRepoResolver()
      await runCycle(config, deps({ sink, glob: async () => [main] }))

      expect(sink.received[0]?.gitEvents).toEqual([
        {
          kind: "commit",
          sha: "2314a2e44",
          branch: "feat/local-source-graph",
          subject: "feat: sub-repo work",
          filesChanged: 3,
          insertions: 8,
          deletions: 2,
          repo: {
            host: "github.com",
            owner: "refrens",
            repoName: "serana",
          },
          callId: "toolu_commit",
        },
      ])
    })

    test("a flush with no git commit in it carries no gitEvents at all", async () => {
      const main = join(projects, "sess-1.jsonl")
      await writeFile(main, `${assistantLine("l1", "sess-1", { cwd: "/work/serana" })}\n`, "utf8")

      const sink = createInMemorySink()
      stubRepoResolver()
      await runCycle(config, deps({ sink, glob: async () => [main] }))

      expect(sink.received[0]).not.toHaveProperty("gitEvents")
    })
  })

  describe("artifact enqueue", () => {
    // A real directory with real files: every candidate is realpath'd and stat'd before it is
    // queued, so a fictional path is indistinguishable from one that was filtered out.
    let app: string
    let rooted: ProjectIdentity

    beforeEach(async () => {
      app = join(dir, "app")
      await mkdir(app, { recursive: true })
      // macOS puts the temp dir behind /private, which is what the candidate resolves to.
      app = await realpath(app)
      rooted = { ...project, root: app }
    })

    const artifact = async (relativePath: string): Promise<string> => {
      const path = join(app, relativePath)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, "bytes\n", "utf8")
      return path
    }

    type WriteLineOptions = {
      readonly type?: "create" | "update"
      readonly originalFile?: string | null
      readonly timestamp?: string
      readonly agentId?: string
    }

    const writeLine = (
      uuid: string,
      sessionId: string,
      filePath: string,
      over: WriteLineOptions = {},
    ) =>
      JSON.stringify({
        uuid,
        sessionId,
        cwd: app,
        timestamp: over.timestamp ?? "2026-07-23T00:00:00.000Z",
        ...(over.agentId === undefined ? {} : { agentId: over.agentId }),
        toolUseResult: {
          filePath,
          type: over.type ?? "create",
          ...(over.originalFile === undefined ? {} : { originalFile: over.originalFile }),
        },
      })

    const withQueue = (queuePath: string): WatcherConfig => ({
      ...config,
      artifactQueuePath: queuePath,
    })
    const rootedDeps = (over: Partial<WatcherDeps> = {}) => ({
      resolveProject: async () => rooted,
      ...over,
    })

    test("S9: a cycle enqueues an in-scope write without ever reading the artifact", async () => {
      const main = join(projects, "sess-1.jsonl")
      const target = await artifact("src/a.ts")
      await writeFile(main, `${writeLine("l1", "sess-1", "src/a.ts")}\n`, "utf8")
      const queuePath = join(dir, "artifact-queue.json")

      const reads: string[] = []
      const watched: FileSystem = {
        ...nodeFs,
        readFile: async (path) => {
          reads.push(path)
          return nodeFs.readFile(path)
        },
      }
      const sink = createInMemorySink()
      await runCycle(
        withQueue(queuePath),
        deps({ sink, glob: async () => [main], fs: watched, ...rootedDeps() }),
      )

      const queue = JSON.parse(await readFile(queuePath, "utf8")) as {
        entries: Array<{ path: string; relativePath: string; created: boolean }>
      }
      expect(queue.entries.map((e) => e.path)).toEqual([target])
      expect(queue.entries[0]?.relativePath).toBe("src/a.ts")
      expect(queue.entries[0]?.created).toBe(true)

      // The artifact's own bytes are never read during a cycle -- only the transcript is.
      expect(reads).not.toContain(target)
      // Nothing uploaded the artifact: the sink only ever saw the transcript payload.
      expect(sink.received).toHaveLength(1)
    })

    test("a write's originalFile reaches the queue as the entry's base", async () => {
      const main = join(projects, "sess-1.jsonl")
      await artifact("src/a.ts")
      await writeFile(
        main,
        `${writeLine("l1", "sess-1", "src/a.ts", { type: "update", originalFile: "before\n" })}\n`,
        "utf8",
      )
      const queuePath = join(dir, "artifact-queue.json")

      await runCycle(withQueue(queuePath), deps({ glob: async () => [main], ...rootedDeps() }))

      const queue = JSON.parse(await readFile(queuePath, "utf8")) as {
        entries: Array<{ created: boolean; base?: string }>
      }
      expect(queue.entries[0]?.created).toBe(false)
      expect(queue.entries[0]?.base).toBe("before\n")
    })

    test("SC30 (regression): capture works with no file-history directory -- the edit's own result line carries a base all the way to a real upload, with enough there for a non-empty diff", async () => {
      const main = join(projects, "sess-1.jsonl")
      const queuePath = join(dir, "artifact-queue.json")
      const statePath = join(dir, "artifacts.json")
      const target = join(app, "docs/notes.md")
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, "Changed line.\n", "utf8")
      await writeFile(
        main,
        `${writeLine("l1", "sess-1", "docs/notes.md", { type: "update", originalFile: "Original line.\n" })}\n`,
        "utf8",
      )

      await runCycle(withQueue(queuePath), deps({ glob: async () => [main], ...rootedDeps() }))

      const sent: Array<{ baseContent?: string; currentContent: string }> = []
      const sink = {
        send: async (payload: { baseContent?: string; currentContent: string }) => {
          sent.push(payload)
          return { status: 200 }
        },
      }
      await runArtifactWorkers(
        { queuePath, statePath, workers: 1, drainOnce: true },
        {
          log: createLogger({ service: "test" }, { level: "silent" }),
          sink,
          clock: { now: () => Date.now() },
        },
      )

      expect(sent).toHaveLength(1)
      expect(sent[0]?.baseContent).toBe("Original line.\n")
      expect(sent[0]?.currentContent).toBe("Changed line.\n")
      expect(sent[0]?.baseContent).not.toBe(sent[0]?.currentContent)
    })

    test("S9: an out-of-scope write is filtered out before it reaches the queue", async () => {
      const main = join(projects, "sess-1.jsonl")
      const excluded = await artifact("node_modules/pkg/index.js")
      await writeFile(main, `${writeLine("l1", "sess-1", excluded)}\n`, "utf8")
      const queuePath = join(dir, "artifact-queue.json")

      await runCycle(withQueue(queuePath), deps({ glob: async () => [main], ...rootedDeps() }))

      expect(await readFile(queuePath, "utf8").catch(() => null)).toBeNull()
    })

    test("S9: a scratch write is enqueued named against its scratch root", async () => {
      const main = join(projects, "sess-1.jsonl")
      const scratch = join(await realpath(tmpdir()), `samskara-driver-${randomUUID()}.md`)
      await writeFile(scratch, "scratch bytes\n", "utf8")
      await writeFile(main, `${writeLine("l1", "sess-1", scratch)}\n`, "utf8")
      const queuePath = join(dir, "artifact-queue.json")

      await runCycle(withQueue(queuePath), deps({ glob: async () => [main], ...rootedDeps() }))

      const queue = JSON.parse(await readFile(queuePath, "utf8")) as {
        entries: Array<{ path: string; relativePath: string }>
      }
      expect(queue.entries).toEqual([
        expect.objectContaining({ path: scratch, relativePath: basename(scratch) }),
      ])
      await rm(scratch, { force: true })
    })

    test("S13: a project with no resolved root enqueues nothing but still checkpoints", async () => {
      const main = join(projects, "sess-1.jsonl")
      await writeFile(main, `${writeLine("l1", "sess-1", "src/a.ts")}\n`, "utf8")
      const queuePath = join(dir, "artifact-queue.json")

      const store = await runCycle(
        withQueue(queuePath),
        deps({
          glob: async () => [main],
          // An identity carrying no root: artifact capture has nothing to scan.
          resolveProject: async () => project,
        }),
      )

      expect(store.checkpoints[main]?.lineProcessed).toBe(1)
      expect(await readFile(queuePath, "utf8").catch(() => null)).toBeNull()
    })

    test("S38: workers do not delay the cycle -- checkpoints advance while an upload is still in flight", async () => {
      const main = join(projects, "sess-1.jsonl")
      const queuePath = join(dir, "artifact-queue.json")
      const statePath = join(dir, "artifacts.json")
      const artifactFile = join(dir, "slow.md")
      await writeFile(artifactFile, "slow bytes\n", "utf8")
      await artifact("docs/a.md")
      await writeFile(main, `${writeLine("l1", "sess-1", "docs/a.md")}\n`, "utf8")

      // A sink slower than a cycle: it only resolves once the test releases it, so anything
      // that awaited the workers could not return.
      let release = (): void => {}
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      let inFlight = false
      const slowSink = {
        send: async () => {
          inFlight = true
          await held
          return { status: 200 }
        },
      }

      await enqueue(queuePath, [
        {
          sessionId: "sess-1",
          path: artifactFile,
          relativePath: "docs/a.md",
          projectRoot: dir,
          created: true,
          observedAt: "2026-07-28T12:00:00.000Z",
          attempts: 0,
        },
      ])

      const workers = runArtifactWorkers(
        { queuePath, statePath, workers: 1, drainOnce: true },
        {
          log: createLogger({ service: "test" }, { level: "silent" }),
          sink: slowSink,
          clock: { now: () => Date.now() },
        },
      )

      // Wait until the upload is genuinely blocked, so the cycle below overlaps it.
      while (!inFlight) await new Promise((resolve) => setTimeout(resolve, 5))

      const store = await runCycle(
        withQueue(queuePath),
        deps({ glob: async () => [main], ...rootedDeps() }),
      )

      // The cycle finished and checkpointed while the upload was still held open.
      expect(store.checkpoints[main]?.lineProcessed).toBe(1)
      expect(inFlight).toBe(true)

      release()
      await workers
    })

    test("S10: a file written across three cycles stays one queue entry", async () => {
      const main = join(projects, "sess-1.jsonl")
      const queuePath = join(dir, "artifact-queue.json")
      const cycleDeps = (over: Partial<WatcherDeps> = {}) =>
        deps({ glob: async () => [main], ...rootedDeps(), ...over })

      await artifact("docs/a.md")
      await writeFile(main, `${writeLine("l1", "sess-1", "docs/a.md")}\n`, "utf8")
      await runCycle(withQueue(queuePath), cycleDeps({ clock: { now: () => 1000 } }))

      await writeFile(main, `${writeLine("l2", "sess-1", "docs/a.md")}\n`, { flag: "a" })
      await runCycle(withQueue(queuePath), cycleDeps({ clock: { now: () => 2000 } }))

      await writeFile(main, `${writeLine("l3", "sess-1", "docs/a.md")}\n`, { flag: "a" })
      await runCycle(withQueue(queuePath), cycleDeps({ clock: { now: () => 3000 } }))

      const queue = JSON.parse(await readFile(queuePath, "utf8")) as {
        entries: Array<{ path: string; observedAt: string }>
      }
      expect(queue.entries).toHaveLength(1)
      expect(queue.entries[0]?.observedAt).toBe(new Date(3000).toISOString())
    })

    test("S10: a file whose enqueue failed is queued by the next cycle", async () => {
      // A failed enqueue throws before the checkpoint is written, so the next cycle re-reads the
      // same line. Nothing records the file as handled ahead of the write that handles it.
      const main = join(projects, "sess-1.jsonl")
      await artifact("docs/a.md")
      await writeFile(main, `${writeLine("l1", "sess-1", "docs/a.md")}\n`, "utf8")

      // A directory cannot be written as a file, so the enqueue throws.
      const blocked = join(dir, "blocked-queue")
      await mkdir(blocked, { recursive: true })
      await runCycle(withQueue(blocked), deps({ glob: async () => [main], ...rootedDeps() })).catch(
        () => undefined,
      )

      const queuePath = join(dir, "retry-queue.json")
      await runCycle(withQueue(queuePath), deps({ glob: async () => [main], ...rootedDeps() }))

      const queue = JSON.parse(await readFile(queuePath, "utf8")) as { entries: unknown[] }
      expect(queue.entries).toHaveLength(1)
    })

    test("SC40: a file written by both the main thread and a subagent merges into one queue entry, taking the earlier write's base", async () => {
      const main = join(projects, "sess-1.jsonl")
      const sub = join(projects, "sess-1", "subagents", "agent-af66.jsonl")
      await mkdir(join(projects, "sess-1", "subagents"), { recursive: true })
      const target = await artifact("src/shared.ts")

      // Main is stamped after the subagent, so track order and time order pick different bases.
      await writeFile(
        main,
        `${writeLine("main-write", "sess-1", "src/shared.ts", {
          type: "update",
          originalFile: "later main content\n",
          timestamp: "2026-07-23T00:00:01.000Z",
        })}\n`,
        "utf8",
      )
      await writeFile(
        sub,
        `${writeLine("sub-write", "sess-1", "src/shared.ts", {
          type: "update",
          originalFile: "earlier subagent content\n",
          timestamp: "2026-07-23T00:00:00.000Z",
          agentId: "af66",
        })}\n`,
        "utf8",
      )
      await writeFile(
        sub.replace(/\.jsonl$/, ".meta.json"),
        JSON.stringify({ agentId: "af66" }),
        "utf8",
      )

      const queuePath = join(dir, "artifact-queue.json")
      await runCycle(withQueue(queuePath), deps({ glob: async () => [main, sub], ...rootedDeps() }))

      const queue = JSON.parse(await readFile(queuePath, "utf8")) as {
        entries: Array<{ path: string; base?: string }>
      }
      expect(queue.entries).toHaveLength(1)
      expect(queue.entries[0]?.path).toBe(target)
      expect(queue.entries[0]?.base).toBe("earlier subagent content\n")
    })
  })

  // A single high-fanout line whose first chunk sends but whose next chunk fails must NOT record a
  // checkpoint, so the plugin re-reads it next cycle (advancing on a mid-line success would freeze
  // the file's mtime/size and skip it forever).
  test("a straddling first chunk that succeeds then fails advances nothing", async () => {
    const key = "/fake/huge.jsonl"
    const track = {
      type: "main" as const,
      sessionId: "sess-huge",
      project,
      sourceRelativePath: key,
      checkpointKey: key,
      records: [record(1, DEFAULT_MESSAGE_CAP + 5), record(2, 1)],
      lastLineProcessed: 2,
      checkpointAt: (lineNumber: number) => ({
        source: "claude_code" as const,
        mtime: 10,
        size: 20,
        lineProcessed: lineNumber,
      }),
    }
    const stubPlugin = {
      source: "claude_code",
      collect: async () => [{ sessionId: "sess-huge", tracks: [track] }],
    }

    let call = 0
    const sink = createInMemorySink(() => (++call === 1 ? 500 : 200))
    const store = await runCycle(config, deps({ sink, glob: async () => [], plugin: stubPlugin }))

    expect(sink.received.length).toBe(1)
    expect(store.checkpoints[key]).toBeUndefined()
  })

  test("a call and its result split across the message cap still yield the commit, on the result's payload", async () => {
    const key = "/fake/split.jsonl"
    const base = {
      sessionId: "sess-split",
      source: "claude_code" as const,
      sourceSchemaVersion: 1,
      trackId: "main",
    }
    const one = (lineNumber: number, message: NormalizedMessage): ParsedRecord => ({
      lineUuid: `00000000-0000-5000-8000-${lineNumber.toString().padStart(12, "0")}`,
      lineNumber,
      raw: {},
      messages: [message],
    })
    const call: NormalizedMessage = {
      ...base,
      subIndex: 0,
      msgType: "toolCall",
      details: { callId: "call-split", name: "Bash", input: { command: "git commit -m split" } },
    }
    const result: NormalizedMessage = {
      ...base,
      subIndex: 0,
      msgType: "toolResult",
      details: {
        callId: "call-split",
        output: "[main abc1234] split\n 1 file changed, 1 insertion(+)",
        status: "unknown",
      },
    }
    const track = {
      type: "main" as const,
      sessionId: "sess-split",
      project,
      sourceRelativePath: key,
      checkpointKey: key,
      records: [record(1, DEFAULT_MESSAGE_CAP - 1), one(2, call), one(3, result)],
      lastLineProcessed: 3,
      checkpointAt: (lineNumber: number) => ({
        source: "claude_code" as const,
        mtime: 10,
        size: 20,
        lineProcessed: lineNumber,
      }),
    }
    const stubPlugin = {
      source: "claude_code",
      collect: async () => [{ sessionId: "sess-split", tracks: [track] }],
    }

    const sink = createInMemorySink()
    await runCycle(config, deps({ sink, glob: async () => [], plugin: stubPlugin }))

    expect(sink.received).toHaveLength(2)
    expect(sink.received[0]).not.toHaveProperty("gitEvents")
    expect(sink.received[1]?.gitEvents).toEqual([
      {
        kind: "commit",
        sha: "abc1234",
        branch: "main",
        subject: "split",
        filesChanged: 1,
        insertions: 1,
        callId: "call-split",
      },
    ])
  })

  test("a synced session logs one info summary, so a healthy sync is visible at LOG_LEVEL=info", async () => {
    const main = join(projects, "sess-1.jsonl")
    await writeFile(main, `${assistantLine("l1", "sess-1")}\n`, "utf8")

    const spy = spyLogger()
    await runCycle(config, deps({ glob: async () => [main], log: spy.log }))

    const [entry] = spy.info.filter((call) => call.message === "session synced")
    expect(entry?.details.sessionId).toBe("sess-1")
    expect(entry?.details.repo).toBe("acme-widget")
    expect(entry?.details.chunks).toBe(1)
    expect(entry?.details.messages).toBeGreaterThan(0)
  })

  test("the summary carries the request ids the server saw, so both logs join on one string", async () => {
    const main = join(projects, "sess-1.jsonl")
    await writeFile(main, `${assistantLine("l1", "sess-1")}\n`, "utf8")

    const spy = spyLogger()
    const sink = createInMemorySink()
    await runCycle(config, deps({ sink, glob: async () => [main], log: spy.log }))

    const [entry] = spy.info.filter((call) => call.message === "session synced")
    expect(entry?.details.reqIds).toEqual(sink.requestIds)
    expect(sink.requestIds).toHaveLength(1)
  })

  test("a failed flush names the request id the server logged it under", async () => {
    const main = join(projects, "sess-1.jsonl")
    await writeFile(main, `${assistantLine("l1", "sess-1")}\n`, "utf8")

    const spy = spyLogger()
    const sink = createInMemorySink(() => 500)
    await runCycle(config, deps({ sink, glob: async () => [main], log: spy.log }))

    expect(spy.warn[0]?.details.reqId).toBe(sink.requestIds[0])
    expect(spy.info.filter((call) => call.message === "session synced")).toHaveLength(0)
  })

  test("a flush that stops on a failed chunk is not reported as a healthy sync", async () => {
    const key = "/fake/partial.jsonl"
    const track = {
      type: "main" as const,
      sessionId: "sess-partial",
      project,
      sourceRelativePath: key,
      checkpointKey: key,
      records: [record(1, DEFAULT_MESSAGE_CAP + 5), record(2, 1)],
      lastLineProcessed: 2,
      checkpointAt: (lineNumber: number) => ({
        source: "claude_code" as const,
        mtime: 10,
        size: 20,
        lineProcessed: lineNumber,
      }),
    }
    const stubPlugin = {
      source: "claude_code",
      collect: async () => [{ sessionId: "sess-partial", tracks: [track] }],
    }

    let call = 0
    const sink = createInMemorySink(() => (++call === 1 ? 200 : 500))
    const spy = spyLogger()
    await runCycle(config, deps({ sink, glob: async () => [], plugin: stubPlugin, log: spy.log }))

    expect(sink.received).toHaveLength(2)
    expect(spy.info.filter((entry) => entry.message === "session synced")).toHaveLength(0)
    const [partial] = spy.warn.filter((entry) => entry.message.includes("partially synced"))
    expect(partial?.details.sessionId).toBe("sess-partial")
    expect(partial?.details.chunks).toBe(1)
  })
})
