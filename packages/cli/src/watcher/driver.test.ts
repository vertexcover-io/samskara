import { mkdir, mkdtemp, readFile, rename, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type FileSystem,
  type NormalizedMessage,
  type ParsedRecord,
  type ProjectIdentity,
  createClaudePlugin,
  createLogger,
} from "@samskara/core"
import { beforeEach, describe, expect, test, vi } from "vitest"
import { enqueue } from "./artifact-queue.js"
import { runArtifactWorkers } from "./artifact-worker.js"
import {
  MESSAGE_CAP,
  type WatcherConfig,
  type WatcherDeps,
  runCycle,
  sliceByMessages,
} from "./driver.js"
import type { ResolvedRepo } from "./resolveRepo.js"
import { createInMemorySink } from "./sink.js"

// The driver binds these at module load, so the mock must replace the module, not a dep.
const repoMocks = vi.hoisted(() => ({
  resolveRepo: vi.fn<(cwd: string) => Promise<ResolvedRepo | null>>(async () => null),
  resolveHead: vi.fn<(cwd: string) => Promise<string | null>>(async () => null),
}))

vi.mock("../project-resolver.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createLocalRepoResolver: () => repoMocks.resolveRepo,
  resolveLocalHeadSha: repoMocks.resolveHead,
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
    const boundaryChunks = sliceByMessages([record(1, 1999), record(2, 2)], MESSAGE_CAP)
    expect(
      boundaryChunks.map((chunk) => chunk.records.flatMap((item) => item.messages).length),
    ).toEqual([1999, 2])
    expect(boundaryChunks.flatMap((chunk) => chunk.records).map((item) => item.lineNumber)).toEqual(
      [1, 2],
    )

    const oversizeChunks = sliceByMessages([record(3, 2500)], MESSAGE_CAP)
    expect(oversizeChunks).toHaveLength(1)
    expect(oversizeChunks[0]?.records[0]?.messages).toHaveLength(2500)
    expect(oversizeChunks[0]?.lastCompleteLine).toBe(3)
  })
})

describe("watcher driver", () => {
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
    projects = join(dir, ".claude", "projects", "bucket")
    await mkdir(projects, { recursive: true })
    config = { statePath: join(dir, "state.json") }
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
    // Each line fans out into 2 messages; 1500 lines → 3000 messages → ≥2 chunks at cap 2000.
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

  describe("repo attribution", () => {
    const serana = {
      host: "github.com",
      owner: "refrens",
      ownerType: "org",
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
        ownerType: "org",
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
            ownerType: "org",
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
    // The transcript's cwd is /work/app, so the project root must contain it for the written
    // file to be judged in scope.
    const rooted: ProjectIdentity = { ...project, root: "/work/app" }

    const writeLine = (uuid: string, sessionId: string, filePath: string) =>
      JSON.stringify({
        uuid,
        sessionId,
        cwd: "/work/app",
        timestamp: "2026-07-23T00:00:00.000Z",
        message: {
          role: "assistant",
          model: "claude-opus-4-8",
          content: [
            {
              type: "tool_use",
              id: `toolu_${uuid}`,
              name: "Write",
              input: { file_path: filePath },
            },
          ],
        },
      })

    const artifactDeps = (queuePath: string, over: Partial<WatcherDeps> = {}) => ({
      resolveProject: async () => rooted,
      artifacts: {
        queuePath,
        seen: new Map<string, string>(),
        realpath: async (path: string) => path,
        stat: async () => ({ size: 10, mtimeMs: 1 }),
      },
      ...over,
    })

    test("S9: a cycle enqueues an in-scope write without ever reading the artifact", async () => {
      const main = join(projects, "sess-1.jsonl")
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
        config,
        deps({ sink, glob: async () => [main], fs: watched, ...artifactDeps(queuePath) }),
      )

      const queue = JSON.parse(await readFile(queuePath, "utf8")) as {
        entries: Array<{ path: string; relativePath: string; changeKind: string }>
      }
      expect(queue.entries.map((e) => e.path)).toEqual(["/work/app/src/a.ts"])
      expect(queue.entries[0]?.relativePath).toBe("src/a.ts")
      expect(queue.entries[0]?.changeKind).toBe("created")

      // The artifact's own bytes are never read during a cycle -- only the transcript is.
      expect(reads).not.toContain("/work/app/src/a.ts")
      // Nothing uploaded the artifact: the sink only ever saw the transcript payload.
      expect(sink.received).toHaveLength(1)
    })

    test("S16: a delta's backupFileName reaches the queue so the base can be resolved", async () => {
      const main = join(projects, "sess-1.jsonl")
      const deltaLine = JSON.stringify({
        uuid: "l2",
        sessionId: "sess-1",
        cwd: "/work/app",
        timestamp: "2026-07-23T00:00:01.000Z",
        type: "file-history-delta",
        // `trackingPath` is what Claude Code emits; `path` here silently resolved no bases at all.
        trackingPath: "src/a.ts",
        backup: { backupFileName: "3c32b39a@v1", version: 1 },
      })
      await writeFile(main, `${writeLine("l1", "sess-1", "src/a.ts")}\n${deltaLine}\n`, "utf8")
      const queuePath = join(dir, "artifact-queue.json")

      await runCycle(config, deps({ glob: async () => [main], ...artifactDeps(queuePath) }))

      const queue = JSON.parse(await readFile(queuePath, "utf8")) as {
        entries: Array<{ backupFileName?: string }>
      }
      expect(queue.entries[0]?.backupFileName).toBe("3c32b39a@v1")
    })

    test("S9: an out-of-scope write is filtered out before it reaches the queue", async () => {
      const main = join(projects, "sess-1.jsonl")
      await writeFile(
        main,
        `${writeLine("l1", "sess-1", "/work/app/node_modules/pkg/index.js")}\n`,
        "utf8",
      )
      const queuePath = join(dir, "artifact-queue.json")

      await runCycle(config, deps({ glob: async () => [main], ...artifactDeps(queuePath) }))

      expect(await readFile(queuePath, "utf8").catch(() => null)).toBeNull()
    })

    test("S13: a project with no resolved root enqueues nothing but still checkpoints", async () => {
      const main = join(projects, "sess-1.jsonl")
      await writeFile(main, `${writeLine("l1", "sess-1", "src/a.ts")}\n`, "utf8")
      const queuePath = join(dir, "artifact-queue.json")

      const store = await runCycle(
        config,
        deps({
          glob: async () => [main],
          ...artifactDeps(queuePath, {}),
          // The --project-slug override path synthesizes an identity carrying no root.
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
          changeKind: "created" as const,
          observedAt: "2026-07-28T12:00:00.000Z",
          attempts: 0,
        },
      ])

      const workers = runArtifactWorkers(
        { queuePath, statePath, workers: 1, drainOnce: true },
        {
          fileHistoryDir: join(dir, "file-history"),
          log: createLogger({ service: "test" }, { level: "silent" }),
          sink: slowSink,
          clock: { now: () => Date.now() },
          runGit: async () => "",
        },
      )

      // Wait until the upload is genuinely blocked, so the cycle below overlaps it.
      while (!inFlight) await new Promise((resolve) => setTimeout(resolve, 5))

      const store = await runCycle(
        config,
        deps({ glob: async () => [main], ...artifactDeps(queuePath) }),
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
        deps({ glob: async () => [main], ...artifactDeps(queuePath), ...over })

      await writeFile(main, `${writeLine("l1", "sess-1", "docs/a.md")}\n`, "utf8")
      await runCycle(config, cycleDeps({ clock: { now: () => 1000 } }))

      await writeFile(main, `${writeLine("l2", "sess-1", "docs/a.md")}\n`, { flag: "a" })
      await runCycle(config, cycleDeps({ clock: { now: () => 2000 } }))

      await writeFile(main, `${writeLine("l3", "sess-1", "docs/a.md")}\n`, { flag: "a" })
      await runCycle(config, cycleDeps({ clock: { now: () => 3000 } }))

      const queue = JSON.parse(await readFile(queuePath, "utf8")) as {
        entries: Array<{ path: string; observedAt: string }>
      }
      expect(queue.entries).toHaveLength(1)
      expect(queue.entries[0]?.observedAt).toBe(new Date(3000).toISOString())
    })

    test("an unchanged file is not re-enqueued on a later cycle", async () => {
      const main = join(projects, "sess-1.jsonl")
      const queuePath = join(dir, "artifact-queue.json")
      // One deps object across both cycles, as the daemon does: `artifactDeps()` is built once and
      // the loop reuses it, so the seen map is what carries across cycles.
      const shared = artifactDeps(queuePath)

      await writeFile(main, `${writeLine("l1", "sess-1", "docs/a.md")}\n`, "utf8")
      await runCycle(config, deps({ glob: async () => [main], ...shared }))

      const first = JSON.parse(await readFile(queuePath, "utf8")) as { entries: unknown[] }
      expect(first.entries).toHaveLength(1)

      // A second cycle over the same unchanged file must not re-observe it.
      await writeFile(main, `${writeLine("l2", "sess-1", "docs/a.md")}\n`, { flag: "a" })
      await runCycle(
        config,
        deps({ glob: async () => [main], clock: { now: () => 9999 }, ...shared }),
      )

      const second = JSON.parse(await readFile(queuePath, "utf8")) as {
        entries: Array<{ observedAt: string }>
      }
      expect(second.entries).toHaveLength(1)
      expect(second.entries[0]?.observedAt).not.toBe(new Date(9999).toISOString())
    })

    test("S10: a file whose enqueue failed is retried, not remembered as already queued", async () => {
      // The seen map must only ever record what actually reached the queue. Recording it before
      // the write succeeds would skip the file on every later cycle -- a silent, permanent drop.
      const main = join(projects, "sess-1.jsonl")
      await writeFile(main, `${writeLine("l1", "sess-1", "docs/a.md")}\n`, "utf8")

      const seen = new Map<string, string>()
      const artifacts = {
        seen,
        realpath: async (path: string) => path,
        stat: async () => ({ size: 10, mtimeMs: 1 }),
      }

      // A directory cannot be written as a file, so the enqueue throws.
      const blocked = join(dir, "blocked-queue")
      await mkdir(blocked, { recursive: true })
      await runCycle(
        config,
        deps({
          glob: async () => [main],
          resolveProject: async () => rooted,
          artifacts: { ...artifacts, queuePath: blocked },
        }),
      ).catch(() => undefined)

      expect(seen.size).toBe(0)

      const queuePath = join(dir, "retry-queue.json")
      await runCycle(
        config,
        deps({
          glob: async () => [main],
          resolveProject: async () => rooted,
          artifacts: { ...artifacts, queuePath },
        }),
      )

      const queue = JSON.parse(await readFile(queuePath, "utf8")) as { entries: unknown[] }
      expect(queue.entries).toHaveLength(1)
      expect(seen.size).toBe(1)
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
      records: [record(1, MESSAGE_CAP + 5), record(2, 1)],
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
      records: [record(1, MESSAGE_CAP - 1), one(2, call), one(3, result)],
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
})
