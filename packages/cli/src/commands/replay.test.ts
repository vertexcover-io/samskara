import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { writeSettings } from "../config/settings.js"
import { belongsToSession, type ReplayDeps, replayCommand } from "./replay.js"

const SESSION = "0b9d4c1e-7f3a-4c22-9a6e-1d5f8b2c3e40"
const OTHER = "9f8e7d6c-5b4a-4c22-9a6e-1d5f8b2c3e41"

describe("belongsToSession", () => {
  test("matches a session's own transcript and its subagent sidecars, not a neighbour's", () => {
    const base = "/home/u/.claude/projects/-work-app"

    expect(belongsToSession(`${base}/${SESSION}.jsonl`, SESSION)).toBe(true)
    // The sidecars are what a name-only match misses, and losing them means the branches never
    // re-ingest while the main spine does.
    expect(belongsToSession(`${base}/${SESSION}/subagents/agent-a1.jsonl`, SESSION)).toBe(true)

    expect(belongsToSession(`${base}/${OTHER}.jsonl`, SESSION)).toBe(false)
    expect(belongsToSession(`${base}/${OTHER}/subagents/agent-a1.jsonl`, SESSION)).toBe(false)
    // A session id appearing as a filename fragment is not the session.
    expect(belongsToSession(`${base}/notes-${SESSION}-copy.jsonl`, SESSION)).toBe(false)
  })
})

describe("replayCommand", () => {
  const originalHome = process.env.SAMSKARA_HOME
  let dir: string
  let paths: ReplayDeps["paths"]
  let started: number
  let stopped: number
  let out: string

  const write = (text: string) => {
    out += text
  }

  const seed = async (): Promise<void> => {
    await writeFile(
      paths.state,
      JSON.stringify({
        apiBase: "https://one.example",
        checkpoints: {
          mine: {
            filePath: `/p/${SESSION}.jsonl`,
            lastUpdatedAt: "x",
            source: "claude_code",
            mtime: 1,
            size: 1,
            lineProcessed: 5,
          },
          branch: {
            filePath: `/p/${SESSION}/subagents/agent-a1.jsonl`,
            lastUpdatedAt: "x",
            source: "claude_code",
            mtime: 1,
            size: 1,
            lineProcessed: 3,
          },
          theirs: {
            filePath: `/p/${OTHER}.jsonl`,
            lastUpdatedAt: "x",
            source: "claude_code",
            mtime: 1,
            size: 1,
            lineProcessed: 9,
          },
        },
      }),
      "utf8",
    )
    await writeFile(
      paths.artifacts,
      JSON.stringify({
        version: 1,
        apiBase: "https://one.example",
        artifacts: {
          [`${SESSION}:/w/a.md`]: { currentHash: "h1", baseCaptured: false },
          [`${OTHER}:/w/b.md`]: { currentHash: "h2", baseCaptured: false },
        },
      }),
      "utf8",
    )
    await writeFile(
      paths.queue,
      JSON.stringify({
        version: 1,
        apiBase: "https://one.example",
        entries: [
          { sessionId: SESSION, path: "/w/a.md" },
          { sessionId: OTHER, path: "/w/b.md" },
        ],
      }),
      "utf8",
    )
  }

  const deps = (over: Partial<ReplayDeps> = {}): ReplayDeps => ({
    apiBase: "http://api.test",
    token: "tok",
    fetch: (async () => new Response(null, { status: 204 })) as typeof globalThis.fetch,
    paths,
    stopWatcher: async () => {
      stopped += 1
      return true
    },
    startWatcher: async () => {
      started += 1
    },
    stdout: { write },
    ...over,
  })

  const readState = async () => JSON.parse(await readFile(paths.state, "utf8"))
  const readArtifacts = async () => JSON.parse(await readFile(paths.artifacts, "utf8"))
  const readQueue = async () => JSON.parse(await readFile(paths.queue, "utf8"))

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "samskara-replay-"))
    // The refusal check reads projects.json under `SAMSKARA_HOME`, pinned here to a temp dir.
    process.env.SAMSKARA_HOME = dir
    paths = {
      state: join(dir, "state.json"),
      artifacts: join(dir, "artifacts.json"),
      queue: join(dir, "artifact-queue.json"),
    }
    started = 0
    stopped = 0
    out = ""
    await seed()
  })

  afterEach(() => {
    process.env.SAMSKARA_HOME = originalHome
  })

  test("clears only the named session from all three local files, and never a neighbour's", async () => {
    expect(await replayCommand(SESSION, deps())).toBe(0)

    expect(Object.keys((await readState()).checkpoints)).toEqual(["theirs"])
    expect(Object.keys((await readArtifacts()).artifacts)).toEqual([`${OTHER}:/w/b.md`])
    expect((await readQueue()).entries).toEqual([{ sessionId: OTHER, path: "/w/b.md" }])
  })

  test("SC14 (regression): replaying a session leaves every stamp alone", async () => {
    expect(await replayCommand(SESSION, deps())).toBe(0)

    expect((await readState()).apiBase).toBe("https://one.example")
    expect((await readArtifacts()).apiBase).toBe("https://one.example")
    expect((await readQueue()).apiBase).toBe("https://one.example")
  })

  test("stops the watcher before touching state and restarts it after", async () => {
    let stateWhenStopped: string | null = null
    await replayCommand(
      SESSION,
      deps({
        stopWatcher: async () => {
          stopped += 1
          stateWhenStopped = await readFile(paths.state, "utf8")
          return true
        },
      }),
    )

    // The watcher holds the same files under lock, so it has to be down before the clear -- proven
    // by the state still being untouched at the moment it was stopped.
    expect(JSON.parse(stateWhenStopped ?? "{}").checkpoints).toHaveProperty("mine")
    expect(stopped).toBe(1)
    expect(started).toBe(1)
  })

  test("a watcher that was not running is not started by the replay", async () => {
    // The stop call is the only probe: it answers false when there was no daemon to stop, so the
    // replay never reads the pid file separately and cannot race between checking and stopping.
    const notRunning = async () => {
      stopped += 1
      return false
    }

    expect(await replayCommand(SESSION, deps({ stopWatcher: notRunning }))).toBe(0)

    expect(started).toBe(0)
  })

  test("a session the server never had is still cleared locally, because 404 is the wanted state", async () => {
    const missing = (async () => new Response(null, { status: 404 })) as typeof globalThis.fetch

    expect(await replayCommand(SESSION, deps({ fetch: missing }))).toBe(0)
    expect(Object.keys((await readState()).checkpoints)).toEqual(["theirs"])
  })

  test("a server that refuses the delete leaves every local file untouched", async () => {
    const refused = (async () => new Response(null, { status: 500 })) as typeof globalThis.fetch

    expect(await replayCommand(SESSION, deps({ fetch: refused }))).toBe(1)

    // Clearing locally while the server keeps the old rows is the half-state this guards: the
    // re-ingest upserts, so stale rows would survive and the replay would prove nothing.
    expect(Object.keys((await readState()).checkpoints).sort()).toEqual([
      "branch",
      "mine",
      "theirs",
    ])
    expect(Object.keys((await readArtifacts()).artifacts)).toHaveLength(2)
    expect((await readQueue()).entries).toHaveLength(2)
    expect(started).toBe(1)
  })

  test("the delete request is bounded, so a stalled server cannot hold the watcher down", async () => {
    let seen: AbortSignal | undefined
    const capturing = ((_url: string, init?: RequestInit) => {
      seen = init?.signal ?? undefined
      return Promise.resolve(new Response(null, { status: 204 }))
    }) as unknown as typeof globalThis.fetch

    await replayCommand(SESSION, deps({ fetch: capturing }))

    expect(seen).toBeInstanceOf(AbortSignal)
  })

  test("an unreachable server aborts, and the watcher still comes back up", async () => {
    const down = (async () => {
      throw new Error("ECONNREFUSED")
    }) as typeof globalThis.fetch

    expect(await replayCommand(SESSION, deps({ fetch: down }))).toBe(1)
    expect(Object.keys((await readState()).checkpoints)).toHaveLength(3)
    expect(started).toBe(1)
  })

  test("without a token it refuses before stopping the watcher", async () => {
    expect(await replayCommand(SESSION, deps({ token: null }))).toBe(1)

    expect(stopped).toBe(0)
    expect(started).toBe(0)
    expect(out).toContain("samskara login")
  })

  test("a mismatched projects.json refuses before stopping the watcher or touching any file", async () => {
    await writeSettings({ apiUrl: "https://two.example", webUrl: "https://two.example" })
    await writeFile(
      join(dir, "projects.json"),
      JSON.stringify({ version: 1, apiBase: "https://one.example", projects: {} }),
      "utf8",
    )

    expect(await replayCommand(SESSION, deps())).toBe(1)

    expect(out).toContain("samskara init --force")
    expect(stopped).toBe(0)
    expect(started).toBe(0)
    expect(Object.keys((await readState()).checkpoints).sort()).toEqual([
      "branch",
      "mine",
      "theirs",
    ])
  })
})
