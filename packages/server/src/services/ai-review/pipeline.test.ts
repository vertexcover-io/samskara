import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { mkdtemp as realMkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { NormalizedMessage, ReviewCounts, SessionExport } from "@samskara/core"
import { buildSessionExport, reviewContractMd, reviewXmlTemplate } from "@samskara/core"
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import Database from "better-sqlite3"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest"
import type { Db } from "../../db/client.js"
import {
  learnings as learningsTable,
  messages,
  projects,
  sessionReviews,
  sessions,
  tokenUsage,
  userProjectGrant,
  users,
} from "../../db/schema.js"
import type { Env } from "../../lib/env.js"
import {
  dockerAvailable,
  localServerUrl,
  type TestDbHandle,
  throwawayOnLocalServer,
} from "../../lib/test-db.js"
import { captureLogger } from "../../lib/test-logger.js"
import { type AiReviewDeps, runAiReview } from "./pipeline.js"
import type { HarnessRunner } from "./runner.js"

const env: Env = {
  githubClientId: "id",
  githubClientSecret: "secret",
  publicBaseUrl: "http://localhost:3000",
  webBaseUrl: "http://localhost:8000",
  cookieSecure: false,
  jwtSecret: "test-secret-value",
  jwtExpiresIn: "7d",
  superAdminLogins: [],
  localLoginSecret: "",
  localLoginLogin: "samskara-dev",
  aiReviewModel: "fake-model",
  aiReviewHarness: "opencode",
  aiReviewTimeoutMs: 600000,
}

const sessionId = "ai-review-pipeline-session"

// Fixture clock: every message carries a timestamp, so the export records carry ts and the
// derived durations are assertable against these exact values.
const T0 = Date.parse("2026-08-20T10:00:00.000Z")
const T0_PLUS_30S = T0 + 30_000
const T0_PLUS_95S = T0 + 95_000
const T0_PLUS_120S = T0 + 120_000

const iso = (ms: number): string => new Date(ms).toISOString()

/** The same NormalizedMessage list the seed writes, so the fixture export matches DB reality. */
const normalizedFixtures: ReadonlyArray<NormalizedMessage> = [
  {
    subIndex: 0,
    sessionId,
    source: "claude_code",
    sourceSchemaVersion: 1,
    trackId: "main",
    msgType: "message",
    role: "user",
    content: { type: "text", value: "fix the build" },
    timestamp: iso(T0),
  },
  {
    subIndex: 1,
    sessionId,
    source: "claude_code",
    sourceSchemaVersion: 1,
    trackId: "main",
    msgType: "toolCall",
    details: { callId: "call-0", name: "Bash", input: { command: "npm test" } },
    timestamp: iso(T0_PLUS_30S),
  },
  {
    subIndex: 2,
    sessionId,
    source: "claude_code",
    sourceSchemaVersion: 1,
    trackId: "main",
    msgType: "toolResult",
    details: { callId: "call-0", output: "", status: "failure" },
    timestamp: iso(T0_PLUS_95S),
  },
  {
    subIndex: 3,
    sessionId,
    source: "claude_code",
    sourceSchemaVersion: 1,
    trackId: "main",
    msgType: "message",
    role: "assistant",
    content: { type: "text", value: "the build is fixed" },
    timestamp: iso(T0_PLUS_120S),
  },
]

const sessionExport: SessionExport = buildSessionExport({
  sessionId,
  title: "flaily session",
  source: "claude_code",
  messages: normalizedFixtures,
})

/**
 * The fixture payload, typed loosely enough to mutate in tests but discriminately enough
 * for the XML writer below to narrow on `lens`.
 */
type FixtureTimelineEntry = {
  readonly id: string
  readonly kind: string
  readonly title: string
  readonly summary: string
  readonly fromSeq: number
  readonly toSeq: number
  readonly messageIds: ReadonlyArray<string>
  readonly tracks: ReadonlyArray<string>
}
type FixtureLearning = {
  readonly title: string
  readonly detail: string
  readonly nextTime?: string
  readonly category: string
  readonly audience: string
  readonly severity: string
  readonly evidence: ReadonlyArray<{
    readonly seq: number
    readonly messageId: string
    readonly what: string
  }>
}
type FixturePayload = {
  readonly analyzer?: string
  readonly model?: string
  readonly harness?: string
  readonly outcome: string
  readonly friction: string
  readonly summary: string
  readonly lenses: ReadonlyArray<
    | { readonly lens: "timeline"; readonly entries: ReadonlyArray<FixtureTimelineEntry> }
    | {
        readonly lens: "humanLearnings" | "agentLearnings" | "breadcrumbs"
        readonly learnings: ReadonlyArray<FixtureLearning>
      }
  >
}

/** A fully grounded, schema-valid payload built from the fixture export's index. */
const validPayload = (index: SessionExport["index"]): FixturePayload => ({
  analyzer: "ai-v1",
  model: "fake-model",
  harness: "test-harness",
  outcome: "productive",
  friction: "moderate",
  summary: "A short session with one retry loop.",
  lenses: [
    {
      lens: "timeline",
      entries: [
        {
          id: "fix-attempted",
          kind: "phase",
          title: "Fixing the build",
          summary: "One prompt, one failed attempt, one fix.",
          fromSeq: index.seqs[0] as number,
          toSeq: index.seqs[0] as number,
          messageIds: [index.messageIds[0] as string],
          tracks: ["main"],
        },
        {
          id: "recovery",
          kind: "turning-point",
          title: "Recovery",
          summary: "The failed call, then the fix.",
          fromSeq: index.seqs[1] as number,
          toSeq: index.seqs[index.seqs.length - 1] as number,
          messageIds: [index.messageIds[1] as string],
          tracks: ["main"],
        },
      ],
    },
    {
      lens: "humanLearnings",
      learnings: [
        {
          title: "Name the failing command",
          detail: "The prompt said fix the build without naming the command that failed.",
          nextTime: "Name the failing command in the prompt.",
          category: "communication",
          audience: "human",
          severity: "medium",
          evidence: [
            {
              seq: index.seqs[0] as number,
              messageId: index.messageIds[0] as string,
              what: "the vague prompt",
            },
          ],
        },
      ],
    },
    {
      lens: "agentLearnings",
      learnings: [
        {
          title: "Stop retrying a failing command",
          detail: "The Bash call failed once; a different approach was available.",
          nextTime: "Try a different approach after the first failure.",
          category: "tool-use",
          audience: "agent",
          severity: "low",
          evidence: [
            {
              seq: index.seqs[1] as number,
              messageId: index.messageIds[1] as string,
              what: "the failed Bash result",
            },
          ],
        },
      ],
    },
    {
      lens: "breadcrumbs",
      learnings: [
        {
          title: "Failed-jobs lookup",
          detail: "The psql query that lists failed jobs with their last error.",
          nextTime: "Reach for this query before writing a new one against the jobs table.",
          category: "query",
          audience: "agent",
          severity: "low",
          evidence: [
            {
              seq: index.seqs[1] as number,
              messageId: index.messageIds[1] as string,
              what: "the query was worked out here",
            },
          ],
        },
      ],
    },
  ],
})

/** The counts the fixture payload actually contains (timeline 2, one learning per section). */
const fixtureCounts = (): ReviewCounts => ({ timeline: 2, human: 1, agent: 1, breadcrumbs: 1 })

/**
 * Serializes a fixture payload into the model-facing v2 XML contract: sections directly under
 * the root (no legacy <lenses> wrapper), learnings carrying audience/severity/nextTime, and a
 * trailing <counts> block. `claimed` overrides the counts so the partial path is testable.
 */
const xmlOf = (payload: FixturePayload, claimed?: ReviewCounts): string => {
  const esc = (text: string): string =>
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  const count = (lens: string): number => {
    const found = payload.lenses.find((candidate) => candidate.lens === lens)
    if (found === undefined) return 0
    return "entries" in found ? found.entries.length : found.learnings.length
  }
  const counts = claimed ?? {
    timeline: count("timeline"),
    human: count("humanLearnings"),
    agent: count("agentLearnings"),
    breadcrumbs: count("breadcrumbs"),
  }
  const lines: string[] = []
  lines.push(
    `<review outcome="${payload.outcome}" friction="${payload.friction}" model="${payload.model}" harness="${payload.harness}">`,
  )
  lines.push(`  <summary>${esc(payload.summary)}</summary>`)
  for (const lens of payload.lenses) {
    if (lens.lens === "timeline") {
      lines.push("  <timeline>")
      for (const entry of lens.entries) {
        lines.push(
          `    <entry id="${entry.id}" kind="${entry.kind}" from-seq="${entry.fromSeq}" to-seq="${entry.toSeq}" tracks="${entry.tracks.join(",")}">`,
          `      <title>${esc(entry.title)}</title>`,
          `      <summary>${esc(entry.summary)}</summary>`,
          "      <message-ids>",
          ...entry.messageIds.map((id) => `        <id>${id}</id>`),
          "      </message-ids>",
          "    </entry>",
        )
      }
      lines.push("  </timeline>")
    } else {
      lines.push(`  <${lens.lens}>`)
      for (const learning of lens.learnings) {
        lines.push(
          `    <learning category="${learning.category}" audience="${learning.audience}" severity="${learning.severity}">`,
          `      <title>${esc(learning.title)}</title>`,
          `      <detail>${esc(learning.detail)}</detail>`,
          `      <nextTime>${esc(learning.nextTime ?? "")}</nextTime>`,
          "      <evidence>",
          ...learning.evidence.map(
            (ref) =>
              `        <ref seq="${ref.seq}" message-id="${ref.messageId}"><what>${esc(ref.what)}</what></ref>`,
          ),
          "      </evidence>",
          "    </learning>",
        )
      }
      lines.push(`  </${lens.lens}>`)
    }
  }
  lines.push(
    `  <counts timeline="${counts.timeline}" human="${counts.human}" agent="${counts.agent}" breadcrumbs="${counts.breadcrumbs}"/>`,
  )
  lines.push("</review>")
  return lines.join("\n")
}

/** Legacy v1 delivery: the whole review fenced in stdout. */
const stdoutWith = (payload: FixturePayload): string =>
  [`Here is my review.`, "", "```xml", xmlOf(payload), "```"].join("\n")

type CapturedRun = {
  prompt: string
  workspaceDir: string
  sessionJson: unknown
  /** review.xml as the harness found it — the template the pipeline staged pre-run. */
  templateXml: string
  /** CONTRACT.md as the harness found it — the reference doc staged beside the template. */
  contractMd: string
}

/**
 * What the fake agent does with the workspace: write a deliverable, empty it, delete it, or
 * leave the staged template untouched; plus what the harness prints and reports.
 */
type AgentBehaviour = {
  readonly stdout: string
  /** Written into workspace review.xml (the v2 deliverable) when non-null. "" empties it. */
  readonly file?: string | null
  /** Deletes review.xml entirely — an agent that never learned the file contract. */
  readonly removeFile?: boolean
  readonly firstByteMs?: number | null
  readonly agentLog?: string
  readonly logPath?: string
}

describe.skipIf(localServerUrl() === undefined && !dockerAvailable())("runAiReview", () => {
  let container: StartedPostgreSqlContainer | undefined
  let handle: TestDbHandle | undefined
  let db: Db

  beforeAll(async () => {
    const local = localServerUrl()
    if (local !== undefined) {
      handle = await throwawayOnLocalServer(local)
      db = handle.db
      return
    }
    container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start()
    const url = container.getConnectionUri()
    handle = await throwawayOnLocalServer(url)
    db = handle.db
  }, 120_000)

  afterAll(async () => {
    await handle?.stop()
    await container?.stop().catch(() => undefined)
  })

  let userId: string
  let projectId: string
  const createdDirs: string[] = []

  beforeEach(async () => {
    createdDirs.length = 0
    await db.delete(sessionReviews)
    await db.delete(learningsTable)
    await db.delete(tokenUsage)
    await db.delete(messages)
    await db.delete(sessions)
    await db.delete(projects)
    await db.delete(users)
    const [user] = await db
      .insert(users)
      .values({ githubId: 1, githubLogin: "dev" })
      .returning({ id: users.id })
    userId = user?.id as string
    const [project] = await db
      .insert(projects)
      .values({ name: "P", slug: "p", ownerUserId: userId })
      .returning({ id: projects.id })
    projectId = project?.id as string
    await db.insert(sessions).values({
      id: sessionId,
      source: "claude_code",
      userId,
      projectId,
      title: "flaily session",
    })
    for (const message of normalizedFixtures) {
      await db.insert(messages).values({
        sessionId,
        lineUuid: crypto.randomUUID(),
        subIndex: message.subIndex,
        msgType: message.msgType,
        role: message.msgType === "message" ? message.role : null,
        lineNumber: message.subIndex + 1,
        source: "claude_code",
        sourceRelativePath: "test.jsonl",
        trackId: message.trackId,
        raw: {},
        sourceSchemaVersion: 1,
        content: message.msgType === "message" ? message.content : null,
        details: "details" in message ? message.details : {},
        timestamp: message.timestamp === undefined ? null : new Date(message.timestamp),
      })
    }
  })

  const mkdtempSpy = ((prefix: string) =>
    realMkdtemp(prefix).then((dir) => {
      createdDirs.push(dir)
      return dir
    })) as typeof realMkdtemp

  const depsWith = (
    runner: HarnessRunner,
    overrides: Partial<AiReviewDeps> = {},
  ): AiReviewDeps => ({
    db,
    runner,
    env,
    log: captureLogger().log,
    mkdtemp: mkdtempSpy,
    ...overrides,
  })

  const fakeRunner = (
    respond: (captured: CapturedRun) => AgentBehaviour,
  ): { runner: HarnessRunner; runs: CapturedRun[] } => {
    const runs: CapturedRun[] = []
    const runner: HarnessRunner = {
      run: async ({ prompt, workspaceDir }) => {
        const sessionJson = JSON.parse(
          readFileSync(`${workspaceDir}/session.json`, "utf8"),
        ) as unknown
        // What the agent found in the workspace BEFORE it started writing: the pipeline must
        // have staged the pre-written template beside the export.
        const templateXml = readFileSync(join(workspaceDir, "review.xml"), "utf8")
        const contractMd = readFileSync(join(workspaceDir, "CONTRACT.md"), "utf8")
        const captured = { prompt, workspaceDir, sessionJson, templateXml, contractMd }
        runs.push(captured)
        const behaviour = respond(captured)
        if (behaviour.removeFile === true) {
          await rm(join(workspaceDir, "review.xml"), { force: true })
        } else if (behaviour.file !== undefined && behaviour.file !== null) {
          await writeFile(join(workspaceDir, "review.xml"), behaviour.file)
        }
        return {
          stdout: behaviour.stdout,
          exitCode: 0,
          firstByteMs: behaviour.firstByteMs ?? null,
          ...(behaviour.agentLog === undefined ? {} : { agentLog: behaviour.agentLog }),
          ...(behaviour.logPath === undefined ? {} : { logPath: behaviour.logPath }),
        }
      },
    }
    return { runner, runs }
  }

  /** The signals jsonb of the single persisted ai-v1 review row. */
  const persistedSignals = async (): Promise<Record<string, unknown>> => {
    const rows = await db
      .select()
      .from(sessionReviews)
      .where(eq(sessionReviews.sessionId, sessionId))
    expect(rows).toHaveLength(1)
    return rows[0]?.signals as Record<string, unknown>
  }

  const okBehaviour = (): AgentBehaviour => ({
    stdout: "review.xml ready: 2 timeline entries",
    file: xmlOf(validPayload(sessionExport.index)),
  })

  test("P1: ok path persists the ai-v1 review, candidate learnings, and cleans the workspace", async () => {
    const { runner, runs } = fakeRunner(() => okBehaviour())
    const result = await runAiReview(depsWith(runner), userId, sessionId)

    expect(result).toMatchObject({ kind: "ok" })
    if (result.kind !== "ok") return
    expect(result.payload.analyzer).toBe("ai-v1")

    const reviewRows = await db
      .select()
      .from(sessionReviews)
      .where(eq(sessionReviews.sessionId, sessionId))
    expect(reviewRows).toHaveLength(1)
    expect(reviewRows[0]).toMatchObject({
      id: result.reviewId,
      projectId,
      analyzer: "ai-v1",
      outcome: "productive",
      friction: "moderate",
      summary: "A short session with one retry loop.",
    })
    expect(reviewRows[0]?.signals).toMatchObject({
      model: "fake-model",
      harness: "opencode",
      lenses: expect.arrayContaining([expect.objectContaining({ lens: "timeline" })]),
    })

    const learningRows = await db.select().from(learningsTable)
    // human + agent become candidates; the harness "Nothing to change" entry is review display
    // data, not a curated lesson for a person or the agent.
    expect(learningRows).toHaveLength(2)
    for (const row of learningRows) {
      expect(row.status).toBe("candidate")
      expect(row.occurrenceCount).toBe(1)
      expect(row.sourceReviewId).toBe(result.reviewId)
    }
    expect(learningRows.map((row) => row.audience).sort()).toEqual(["agent", "human"])
    expect(learningRows.some((row) => row.category === "communication")).toBe(true)
    expect(learningRows.some((row) => row.category === "tool-use")).toBe(true)

    // The runner saw the lean pointer-prompt — the workspace carries the contract, so the
    // prompt names the files and defers to CONTRACT.md. The real sessionId never reaches
    // the workspace — only the alias does.
    expect(runs).toHaveLength(1)
    expect(runs[0]?.prompt).toContain("session-under-review")
    expect(runs[0]?.prompt).not.toContain(sessionId)
    expect(runs[0]?.prompt).toContain("flaily session")
    expect(runs[0]?.prompt).toContain("CONTRACT.md")
    expect(runs[0]?.prompt).not.toContain("<review")
    expect(runs[0]?.sessionJson).toMatchObject({ meta: { sessionId: "session-under-review" } })

    // Workspace cleaned up: the mkdtemp dir existed during the run and is gone after.
    expect(createdDirs).toHaveLength(1)
    expect(existsSync(createdDirs[0] as string)).toBe(false)
  })

  test("P1b: the workspace stages the exact core template and contract beside session.json before the harness runs", async () => {
    const { runner, runs } = fakeRunner(() => okBehaviour())
    const result = await runAiReview(depsWith(runner), userId, sessionId)
    expect(result.kind).toBe("ok")
    expect(runs[0]?.templateXml).toBe(reviewXmlTemplate())
    expect(runs[0]?.contractMd).toBe(reviewContractMd())
  })

  test("P11: AI_REVIEW_HARNESS=claude persists the claude harness on the review instead of a hardcoded one", async () => {
    const { runner } = fakeRunner(() => okBehaviour())
    const result = await runAiReview(
      depsWith(runner, { env: { ...env, aiReviewHarness: "claude", aiReviewModel: "sonnet" } }),
      userId,
      sessionId,
    )
    expect(result.kind).toBe("ok")
    if (result.kind !== "ok") return
    expect(result.payload.harness).toBe("claude")
    expect(await persistedSignals()).toMatchObject({ model: "sonnet", harness: "claude" })
  })

  test("P15: the claude reviewer's transcript is captured from the workspace and persisted on the run", async () => {
    const { runner } = fakeRunner((captured) => {
      const projectDir = join(captured.workspaceDir, "claude-config", "projects", "work")
      mkdirSync(projectDir, { recursive: true })
      writeFileSync(
        join(projectDir, "t.jsonl"),
        `${[
          JSON.stringify({
            type: "user",
            message: { role: "user", content: [{ type: "text", text: "review it" }] },
          }),
          JSON.stringify({
            type: "assistant",
            message: {
              role: "assistant",
              content: [
                { type: "tool_use", name: "Read", input: { file_path: "/work/session.json" } },
                { type: "text", text: "Done." },
              ],
            },
          }),
        ].join("\n")}\n`,
      )
      return okBehaviour()
    })
    const result = await runAiReview(
      depsWith(runner, { env: { ...env, aiReviewHarness: "claude" } }),
      userId,
      sessionId,
    )
    expect(result.kind).toBe("ok")
    const run = (await persistedSignals()).run as {
      transcript?: ReadonlyArray<{ role: string; text?: string; tools?: unknown }>
      recordIds?: ReadonlyArray<string | null>
    }
    expect(run.transcript).toEqual([
      { role: "user", text: "review it" },
      { role: "assistant", text: "Done.", tools: [{ name: "Read", input: "/work/session.json" }] },
    ])
  })

  test("P16: the opencode reviewer's transcript comes from the redirected XDG database", async () => {
    const { runner } = fakeRunner((captured) => {
      const dataDir = join(captured.workspaceDir, "xdg-data", "opencode")
      mkdirSync(dataDir, { recursive: true })
      const db = new Database(join(dataDir, "opencode.db"))
      db.exec(
        "CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, time_created INTEGER, time_updated INTEGER, agent TEXT, model TEXT, title TEXT)",
      )
      db.exec(
        "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)",
      )
      db.exec(
        "CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)",
      )
      db.prepare(
        "INSERT INTO session (id, parent_id, time_created, time_updated) VALUES ('rs1', NULL, 1, 5)",
      ).run()
      db.prepare(
        "INSERT INTO message (id, session_id, time_created, data) VALUES ('rm1', 'rs1', 2, ?)",
      ).run(JSON.stringify({ role: "user" }))
      db.prepare(
        "INSERT INTO part (id, message_id, session_id, time_created, data) VALUES ('rp1', 'rm1', 'rs1', 3, ?)",
      ).run(JSON.stringify({ type: "text", text: "review the export" }))
      db.close()
      return okBehaviour()
    })
    const result = await runAiReview(depsWith(runner), userId, sessionId)
    expect(result.kind).toBe("ok")
    const run = (await persistedSignals()).run as {
      transcript?: ReadonlyArray<{ role: string; text?: string }>
    }
    expect(run.transcript).toEqual([{ role: "user", text: "review the export" }])
  })

  test("P2: re-analysis supersedes — one ai-v1 row, same reviewId, learnings re-upserted", async () => {
    const { runner } = fakeRunner(() => okBehaviour())
    const first = await runAiReview(depsWith(runner), userId, sessionId)
    const second = await runAiReview(depsWith(runner), userId, sessionId)
    expect(first.kind).toBe("ok")
    expect(second.kind).toBe("ok")
    if (first.kind !== "ok" || second.kind !== "ok") return
    expect(second.reviewId).toBe(first.reviewId)

    const reviewRows = await db
      .select()
      .from(sessionReviews)
      .where(eq(sessionReviews.sessionId, sessionId))
    expect(reviewRows).toHaveLength(1)
  })

  test("P2b: occurrenceCount is per distinct session — a re-run is idempotent, a second session bumps", async () => {
    // The index depends only on the normalized messages, and both sessions below carry the
    // same fixtures, so one statically grounded payload serves both.
    const { runner } = fakeRunner(() => okBehaviour())
    await runAiReview(depsWith(runner), userId, sessionId)
    // Re-analysis of the SAME session: same fingerprints, and occurrences must not inflate.
    await runAiReview(depsWith(runner), userId, sessionId)

    let rows = await db.select().from(learningsTable)
    expect(rows).toHaveLength(2)
    for (const row of rows) expect(row.occurrenceCount).toBe(1)

    // A second session reporting identical lessons (identical titles -> identical
    // fingerprints) is a genuinely new sighting: occurrenceCount moves to 2.
    const secondSessionId = `${sessionId}-2`
    await db.insert(sessions).values({
      id: secondSessionId,
      source: "claude_code",
      userId,
      projectId,
      title: "flaily session again",
    })
    for (const message of normalizedFixtures) {
      await db.insert(messages).values({
        sessionId: secondSessionId,
        lineUuid: crypto.randomUUID(),
        subIndex: message.subIndex,
        msgType: message.msgType,
        role: message.msgType === "message" ? message.role : null,
        lineNumber: message.subIndex + 1,
        source: "claude_code",
        sourceRelativePath: "test.jsonl",
        trackId: message.trackId,
        raw: {},
        sourceSchemaVersion: 1,
        content: message.msgType === "message" ? message.content : null,
        details: "details" in message ? message.details : {},
        timestamp: message.timestamp === undefined ? null : new Date(message.timestamp),
      })
    }
    const elsewhere = await runAiReview(depsWith(runner), userId, secondSessionId)
    expect(elsewhere.kind).toBe("ok")

    rows = await db.select().from(learningsTable)
    expect(rows).toHaveLength(2)
    for (const row of rows) expect(row.occurrenceCount).toBe(2)
  })

  test("P3: unknown session -> sessionNotFound", async () => {
    const { runner, runs } = fakeRunner(() => okBehaviour())
    const result = await runAiReview(depsWith(runner), userId, "does-not-exist")
    expect(result).toEqual({ kind: "error", code: "sessionNotFound" })
    expect(runs).toHaveLength(0)
  })

  test("P4: a viewer who cannot edit the project -> notEditable", async () => {
    const [viewer] = await db
      .insert(users)
      .values({ githubId: 2, githubLogin: "viewer" })
      .returning({ id: users.id })
    await db.insert(userProjectGrant).values({
      userId: viewer?.id as string,
      projectId,
      scope: "viewer",
    })
    const { runner, runs } = fakeRunner(() => okBehaviour())
    const result = await runAiReview(depsWith(runner), viewer?.id as string, sessionId)
    expect(result).toEqual({ kind: "error", code: "notEditable" })
    expect(runs).toHaveLength(0)
  })

  test("P5: runner rejection -> harnessFailed with the runner's message", async () => {
    const { runner } = fakeRunner(() => {
      throw new Error("opencode exited 1")
    })
    const result = await runAiReview(depsWith(runner), userId, sessionId)
    expect(result.kind).toBe("error")
    if (result.kind !== "error") return
    expect(result.code).toBe("harnessFailed")
    expect(result.detail).toMatchObject({ message: "opencode exited 1" })
    // Failure still cleans the workspace.
    expect(createdDirs).toHaveLength(1)
    expect(existsSync(createdDirs[0] as string)).toBe(false)
  })

  test("P6: deliverable present but with no recoverable XML -> unparseable with the parser's error and source excerpt", async () => {
    const file = "I could not read session.json, sorry."
    const { runner } = fakeRunner(() => ({ stdout: "review.xml ready", file }))
    const result = await runAiReview(depsWith(runner), userId, sessionId)
    expect(result.kind).toBe("error")
    if (result.kind !== "error") return
    expect(result.code).toBe("unparseable")
    expect(result.detail).toMatchObject({ stdoutStart: file.slice(0, 400) })
    expect((result.detail as { error: unknown }).error).toBeTruthy()
  })

  test("P7: well-formed XML that violates the contract -> unparseable (the parser owns schema checks)", async () => {
    const bad = validPayload(sessionExport.index)
    const xml = xmlOf(bad).replace('outcome="productive"', 'outcome="banana"')
    const { runner } = fakeRunner(() => ({ stdout: "ready", file: xml }))
    const result = await runAiReview(depsWith(runner), userId, sessionId)
    expect(result.kind).toBe("error")
    if (result.kind !== "error") return
    expect(result.code).toBe("unparseable")
    expect(String((result.detail as { error: unknown }).error)).toContain("outcome")
  })

  test("P8: grounded shape but invented message ids -> ungrounded with problems", async () => {
    const payload = validPayload(sessionExport.index)
    // Widen to a mutable shape for the mutation below.
    const timeline = payload.lenses[0] as unknown as {
      entries: Array<{ messageIds: string[] }>
    }
    const entry = timeline.entries[0]
    if (entry === undefined) throw new Error("fixture shape changed")
    entry.messageIds = ["msg-9999"]
    const { runner } = fakeRunner(() => ({ stdout: "ready", file: xmlOf(payload) }))
    const result = await runAiReview(depsWith(runner), userId, sessionId)
    expect(result.kind).toBe("error")
    if (result.kind !== "error") return
    expect(result.code).toBe("ungrounded")
    const detail = result.detail as { problems: Array<{ path: string; problem: string }> }
    expect(detail.problems.length).toBeGreaterThan(0)
    expect(detail.problems.length).toBeLessThanOrEqual(10)
    expect(detail.problems[0]?.path).toContain("messageIds")
  })

  test("P9: missing review.xml falls back to the fenced XML in stdout (legacy v1 delivery)", async () => {
    const { runner } = fakeRunner(() => ({
      stdout: stdoutWith(validPayload(sessionExport.index)),
      removeFile: true,
    }))
    const result = await runAiReview(depsWith(runner), userId, sessionId)
    expect(result.kind).toBe("ok")

    const signals = await persistedSignals()
    // The file was never read, so the deliverable_read milestone never fired...
    const names = ((signals.run as { milestones: Array<{ name: string }> }).milestones ?? []).map(
      (milestone) => milestone.name,
    )
    expect(names).not.toContain("deliverable_read")
    // ...but the review still landed and the run log counts the stdout bytes it parsed.
    expect(signals).toMatchObject({
      model: "fake-model",
      harness: "opencode",
    })
    const run = signals.run as { xmlBytes: number }
    expect(run.xmlBytes).toBeGreaterThan(0)
  })

  test("P9b: an emptied review.xml also falls back to stdout", async () => {
    const { runner } = fakeRunner(() => ({
      stdout: stdoutWith(validPayload(sessionExport.index)),
      file: "",
    }))
    const result = await runAiReview(depsWith(runner), userId, sessionId)
    expect(result.kind).toBe("ok")
    await persistedSignals()
  })

  test("P10: no file deliverable and no XML in stdout -> deliverableMissing naming the last milestone", async () => {
    const { runner } = fakeRunner(() => ({
      stdout: "review.xml ready: 7 timeline entries",
      removeFile: true,
    }))
    const result = await runAiReview(depsWith(runner), userId, sessionId)
    expect(result.kind).toBe("error")
    if (result.kind !== "error") return
    expect(result.code).toBe("deliverableMissing")
    expect(result.detail).toMatchObject({ lastMilestone: "harness_complete" })
    const rows = await db
      .select()
      .from(sessionReviews)
      .where(eq(sessionReviews.sessionId, sessionId))
    expect(rows).toHaveLength(0)
  })

  test("P11: claimed counts that disagree with what parsed persist as partial — no hard fail", async () => {
    const payload = validPayload(sessionExport.index)
    const xml = xmlOf(payload, { timeline: 5, human: 2, agent: 1, breadcrumbs: 1 })
    const { runner } = fakeRunner(() => ({ stdout: "ready", file: xml }))
    const result = await runAiReview(depsWith(runner), userId, sessionId)
    expect(result.kind).toBe("ok")

    const signals = await persistedSignals()
    expect(signals.partial).toEqual({
      claimed: { timeline: 5, human: 2, agent: 1, breadcrumbs: 1 },
      parsed: fixtureCounts(),
    })
  })

  test("P12: server-computed numbers and ts-derived timeline durations persist in signals", async () => {
    // Token totals fold from the tokenUsage table, like services/review.ts does.
    const [messageRow] = await db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(messages.lineNumber)
      .limit(1)
    await db.insert(tokenUsage).values({
      messageId: messageRow?.id as string,
      inputTokens: 100,
      outputTokens: 50,
      cachedTokens: 10,
      thinkingTokens: 5,
    })

    const { runner } = fakeRunner(() => okBehaviour())
    const result = await runAiReview(depsWith(runner), userId, sessionId)
    expect(result.kind).toBe("ok")

    const signals = await persistedSignals()
    // durationMs is the session row's own span (earliest to latest message ts = 120s);
    // recordCount/toolCallCount count the export the reviewer actually saw (toolCall and
    // its result collapse into one record); tokens fold from the tokenUsage table.
    expect(signals.numbers).toEqual({
      durationMs: 120_000,
      recordCount: 3,
      toolCallCount: 1,
      inputTokens: 100,
      outputTokens: 50,
      cachedTokens: 10,
      thinkingTokens: 5,
    })
    // Timeline durations derive from export record ts at fromSeq/toSeq — never model-claimed.
    const lenses = signals.lenses as ReadonlyArray<{
      lens: string
      entries?: ReadonlyArray<{ fromSeq: number; startMs?: number; durationMs?: number }>
    }>
    const timeline = lenses.find((lens) => lens.lens === "timeline")
    const [first, second] = timeline?.entries ?? []
    expect(first).toMatchObject({ fromSeq: 0, startMs: T0, durationMs: 0 })
    expect(second).toMatchObject({
      fromSeq: 1,
      startMs: T0_PLUS_30S,
      durationMs: T0_PLUS_120S - T0_PLUS_30S,
    })
    // Payload-level span: first to last record ts.
    expect(signals.totalDurationMs).toBe(T0_PLUS_120S - T0)
  })

  test("P13: the run log persists — milestones, healing accounting, selfCounts, xmlBytes, capped agentLog", async () => {
    const file = xmlOf(validPayload(sessionExport.index))
    const { runner } = fakeRunner(() => ({
      stdout: "review.xml ready",
      file,
      firstByteMs: 4_200,
      agentLog: "x".repeat(60_000),
    }))
    const result = await runAiReview(depsWith(runner), userId, sessionId)
    expect(result.kind).toBe("ok")

    const signals = await persistedSignals()
    const run = signals.run as {
      startedAt: string
      finishedAt: string
      milestones: ReadonlyArray<{ name: string; at: string; elapsedMs: number }>
      recovered: ReadonlyArray<string>
      selfCounts: ReviewCounts
      xmlBytes: number
      agentLog: string
    }
    expect(new Date(run.startedAt).toISOString()).toBe(run.startedAt)
    expect(new Date(run.finishedAt).toISOString()).toBe(run.finishedAt)
    // Canonical fixture XML heals nothing, and the counts it self-reports parsed as-is.
    expect(run.recovered).toEqual([])
    expect(run.selfCounts).toEqual(fixtureCounts())
    expect(run.xmlBytes).toBe(Buffer.byteLength(file))
    // A runaway agent log cannot balloon the row.
    expect(run.agentLog.length).toBeLessThanOrEqual(24 * 1024)
    // The alias bridge: one real message id per export record (the tool call+result merge
    // into one), so evidence links can scroll.
    const runWithIds = run as typeof run & { recordIds?: ReadonlyArray<string | null> }
    expect(runWithIds.recordIds).toHaveLength(3)
    expect(runWithIds.recordIds?.every((id) => typeof id === "string" && id !== "")).toBe(true)

    const names = run.milestones.map((milestone) => milestone.name)
    // Existing milestone names keep working (scripts/ai-review-watch.sh greps them); the two
    // new ones are additive.
    expect(names).toEqual([
      "workspace_ready",
      "export_written",
      "template_staged",
      "contract_staged",
      "auth_staged",
      "harness_spawning",
      "harness_first_byte",
      "harness_complete",
      "deliverable_read",
      "xml_parsed",
      "grounded",
    ])
    for (const milestone of run.milestones) {
      expect(new Date(milestone.at).toISOString()).toBe(milestone.at)
      expect(milestone.elapsedMs).toBeGreaterThanOrEqual(0)
    }
  })

  test("P14: the deliverable_read milestone logs its byte count", async () => {
    const capture = captureLogger()
    const file = xmlOf(validPayload(sessionExport.index))
    const { runner } = fakeRunner(() => ({ stdout: "ready", file }))
    const result = await runAiReview(depsWith(runner, { log: capture.log }), userId, sessionId)
    expect(result.kind).toBe("ok")
    const line = capture.lines.find(
      (candidate) => (candidate as { milestone?: string }).milestone === "deliverable_read",
    )
    expect(line).toBeDefined()
    expect((line as { bytes?: number }).bytes).toBe(Buffer.byteLength(file))
  })
})
