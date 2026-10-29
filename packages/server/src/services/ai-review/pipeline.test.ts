import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { mkdtemp as realMkdtemp } from "node:fs/promises"
import { join } from "node:path"
import type { HarnessRunner, NormalizedMessage } from "@samskara/core"
import { MAX_REVIEW_MD_BYTES } from "@samskara/core"
import Database from "better-sqlite3"
import { eq, sql } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest"
import type { Db } from "../../db/client.js"
import {
  messages,
  projects,
  reviewProblems as reviewProblemsTable,
  sessionReviews,
  sessions,
  tokenUsage,
  userProjectGrant,
  users,
} from "../../db/schema.js"
import { dockerAvailable, startTestDb } from "../../db/testDb.js"
import type { Env } from "../../lib/env.js"
import { captureLogger } from "../../lib/test-logger.js"
import { type AiReviewDeps, runAiReview } from "./pipeline.js"

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

describe.skipIf(!dockerAvailable())("runAiReview", () => {
  let db: Db
  let teardown: () => Promise<void>

  beforeAll(async () => {
    const started = await startTestDb()
    db = started.db
    teardown = started.teardown
  }, 120_000)

  afterAll(async () => {
    await teardown?.()
  })

  let userId: string
  let projectId: string
  const createdDirs: string[] = []

  beforeEach(async () => {
    createdDirs.length = 0
    await db.delete(sessionReviews)
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
    // Credentials come from the environment now, never a staged file; tests declare one
    // rather than depending on whatever the machine running them happens to export.
    credentialEnv: { OPENCODE_API_KEY: "oc-key", CLAUDE_CODE_OAUTH_TOKEN: "cc-token" },
    ...overrides,
  })

  /** The signals jsonb of the single persisted review row. */
  const persistedSignals = async (): Promise<Record<string, unknown>> => {
    const rows = await db
      .select()
      .from(sessionReviews)
      .where(eq(sessionReviews.sessionId, sessionId))
    expect(rows).toHaveLength(1)
    return rows[0]?.signals as Record<string, unknown>
  }

  describe("the problems reviewer", () => {
    const problemsMd = (quote: string) => `# Review

- **Outcome:** struggled
- **Friction:** moderate

## Summary

The agent claimed the build was fixed after the tests failed.

## Problems

### Said the build was fixed after the tests failed

- **Class:** missed
- **Severity:** high — a broken build would have shipped
- **Fix type:** skill
- **Description:** The agent was expected to rerun the tests after a failure. It said the build was fixed instead.
- **Evidence:** msg-2 — "${quote}" — this is wrong: the only test run, msg-1, failed.
- **Learning:** Rerun the failing tests and read the result before saying the build works.
- **Extra:** stage: coder
`

    /** Answers as every agent the problems review runs: reader, merger, reviewer. */
    const problemsRunner = (
      reviewMd: string,
      merged = "# How to review\n\nmerged by agent",
      readerLeads = "Nothing found.",
      leadAnswers = "",
      /** Runs as the reviewer starts, with its workspace: writes what a real harness leaves. */
      onReview: (workspaceDir: string) => void = () => {},
    ) => {
      const seen: Array<{
        files: string[]
        contract?: string
        user?: string
        leads?: string
        prompt?: string
        session?: unknown
      }> = []
      const runner: HarnessRunner = {
        run: async ({ workspaceDir, oneShot, prompt }) => {
          const has = (name: string) => existsSync(join(workspaceDir, name))
          const user = /^<<<USER\n([\s\S]*?)\nUSER>>>$/m.exec(prompt)?.[1]
          if (user !== undefined) {
            seen.push({ files: [], user })
            return {
              stdout: merged === "" ? "merged" : `<<<MERGED\n${merged}\nMERGED>>>`,
              firstByteMs: 1,
            }
          }
          if (oneShot) return { stdout: readerLeads, firstByteMs: 1 }
          seen.push({
            files: ["session.json", "leads.md", "CONTRACT.md"].filter((name) => has(name)),
            contract: readFileSync(join(workspaceDir, "CONTRACT.md"), "utf8"),
            leads: readFileSync(join(workspaceDir, "leads.md"), "utf8"),
            prompt,
            session: JSON.parse(readFileSync(join(workspaceDir, "session.json"), "utf8")),
          })
          onReview(workspaceDir)
          writeFileSync(join(workspaceDir, "review.md"), reviewMd)
          writeFileSync(join(workspaceDir, "leads-answered.md"), leadAnswers)
          return { stdout: "review.md ready", firstByteMs: 1 }
        },
      }
      return { runner, seen }
    }

    const savedProblems = () =>
      db.select().from(reviewProblemsTable).where(eq(reviewProblemsTable.sessionId, sessionId))

    test("PR1: the review reads the full session and saves the review row and each problem", async () => {
      const { runner, seen } = problemsRunner(problemsMd("the build is fixed"))
      const result = await runAiReview(depsWith(runner), userId, sessionId, {})

      expect(result).toMatchObject({ kind: "ok" })
      expect(seen[0]?.files).toEqual(["session.json", "leads.md", "CONTRACT.md"])
      const [row] = await db
        .select()
        .from(sessionReviews)
        .where(eq(sessionReviews.sessionId, sessionId))
      expect(row).toMatchObject({
        analyzer: "ai-problems-v2",
        outcome: "struggled",
        friction: "moderate",
      })
      expect(row?.signals).toMatchObject({ prompt: "base", dropped: [], model: "fake-model" })
      const problems = await savedProblems()
      expect(problems).toHaveLength(1)
      expect(problems[0]).toMatchObject({
        reviewId: row?.id,
        title: "Said the build was fixed after the tests failed",
        class: "missed",
        severity: "high",
        fixType: "skill",
        extra: { stage: "coder" },
      })
    })

    test("PR2: a problem quoting what is not in the session is dropped, and the drop is recorded", async () => {
      const { runner } = problemsRunner(problemsMd("tests are all green"))
      const result = await runAiReview(depsWith(runner), userId, sessionId, {})

      expect(result).toMatchObject({ kind: "ok" })
      expect(await savedProblems()).toEqual([])
      expect(await persistedSignals()).toMatchObject({
        dropped: [
          '"Said the build was fixed after the tests failed": "tests are all green" is not in msg-2',
        ],
      })
    })

    test("PR3: a custom prompt is merged first, and the reviewer's contract is the merge plus the fixed output", async () => {
      const { runner, seen } = problemsRunner(problemsMd("the build is fixed"))
      const result = await runAiReview(depsWith(runner), userId, sessionId, {
        prompt: "After plan approval every human message is a problem.",
      })

      expect(result).toMatchObject({ kind: "ok" })
      expect(seen[0]?.user).toBe("After plan approval every human message is a problem.")
      expect(seen[1]?.contract?.startsWith("# How to review\n\nmerged by agent")).toBe(true)
      expect(seen[1]?.contract).toContain("# Files and output (fixed)")
      expect(await persistedSignals()).toMatchObject({ prompt: "custom" })
    })

    test("PR4: a merge that writes nothing stops the run before any review", async () => {
      const { runner, seen } = problemsRunner(problemsMd("the build is fixed"), "")
      const result = await runAiReview(depsWith(runner), userId, sessionId, {
        prompt: "anything",
      })

      expect(result).toMatchObject({ kind: "error", code: "promptMergeFailed" })
      expect(seen).toHaveLength(1)
      expect(await db.select().from(sessionReviews)).toEqual([])
    })

    test("PR5: a review.md that is not a review saves nothing", async () => {
      const { runner } = problemsRunner("not a review")
      const result = await runAiReview(depsWith(runner), userId, sessionId, {})

      expect(result).toMatchObject({ kind: "error", code: "unparseable" })
      expect(await db.select().from(sessionReviews)).toEqual([])
    })

    test("PR6: an extra field the merged prompt asks for is required on every problem", async () => {
      const merged = "# How to review\n\n## Extra fields\n\n- topic: what the person asked about\n"
      const { runner } = problemsRunner(problemsMd("the build is fixed"), merged)
      const result = await runAiReview(depsWith(runner), userId, sessionId, {
        prompt: "Add a topic field.",
      })

      expect(result).toMatchObject({ kind: "ok" })
      expect(await savedProblems()).toEqual([])
      expect(await persistedSignals()).toMatchObject({
        dropped: ['"Said the build was fixed after the tests failed": missing Extra "topic"'],
      })
    })

    test("PR7: a problem write that fails rolls the review row back", async () => {
      await db.execute(
        sql`create or replace function fail_problem() returns trigger language plpgsql as $$
          begin raise exception 'problem write refused'; end $$`,
      )
      await db.execute(
        sql`create trigger fail_problem_trigger before insert on "reviewProblems"
          for each row execute function fail_problem()`,
      )
      try {
        const { runner } = problemsRunner(problemsMd("the build is fixed"))
        await expect(runAiReview(depsWith(runner), userId, sessionId, {})).rejects.toThrow()
      } finally {
        await db.execute(sql`drop trigger if exists fail_problem_trigger on "reviewProblems"`)
      }
      expect(await db.select().from(sessionReviews)).toEqual([])
    })

    test("PR8: a redo keeps the review's id and replaces its problems", async () => {
      const first = await runAiReview(
        depsWith(problemsRunner(problemsMd("the build is fixed")).runner),
        userId,
        sessionId,
        {},
      )
      const second = await runAiReview(
        depsWith(
          problemsRunner(
            problemsMd("the build is fixed").replace("Said the build", "Claimed the build"),
          ).runner,
        ),
        userId,
        sessionId,
        {},
      )
      expect(second).toMatchObject({
        kind: "ok",
        reviewId: first.kind === "ok" ? first.reviewId : "",
      })
      expect((await savedProblems()).map((row) => row.title)).toEqual([
        "Claimed the build was fixed after the tests failed",
      ])
    })

    test("PR9: no review.md is deliverableMissing, and one past the size cap saves nothing", async () => {
      const missing: HarnessRunner = { run: async () => ({ stdout: "", firstByteMs: null }) }
      expect(await runAiReview(depsWith(missing), userId, sessionId, {})).toMatchObject({
        kind: "error",
        code: "deliverableMissing",
      })

      const huge = problemsMd("the build is fixed") + "x".repeat(MAX_REVIEW_MD_BYTES)
      const { runner } = problemsRunner(huge)
      expect(await runAiReview(depsWith(runner), userId, sessionId, {})).toMatchObject({
        kind: "error",
        code: "unparseable",
      })
      expect(await db.select().from(sessionReviews)).toEqual([])
    })

    test("PR10: leads the review never answered are saved with it", async () => {
      const { runner } = problemsRunner(
        problemsMd("the build is fixed"),
        undefined,
        undefined,
        "- L1: dropped (no kind) — the opening request\n",
      )
      await runAiReview(depsWith(runner), userId, sessionId, {})
      const signals = (await persistedSignals()) as {
        unaccountedLeads: string[]
        leadCount: number
      }
      expect(signals.leadCount).toBeGreaterThan(0)
      expect(signals.unaccountedLeads).not.toContain("L1")
      expect(signals.unaccountedLeads).toHaveLength(signals.leadCount - 1)
    })

    test("PR11: what the readers find becomes a lead the reviewer must answer, and their counts are saved", async () => {
      const { runner } = problemsRunner(
        problemsMd("the build is fixed"),
        undefined,
        '- msg-2 — "the build is fixed" — said after the only test run failed',
      )
      await runAiReview(depsWith(runner), userId, sessionId, {})
      const signals = (await persistedSignals()) as {
        readers: { pieces: number; leads: number; failedPieces: string[] }
        unaccountedLeads: string[]
        leads: string
      }
      expect(signals.readers).toMatchObject({ pieces: 1, leads: 1, failedPieces: [] })
      expect(signals.leads).toContain("said after the only test run failed")
      // L1 is the reader's lead, and this review never answered it.
      expect(signals.unaccountedLeads).toContain("L1")
    })

    test("PR13: a reviewer whose harness fails after the readers ends the run as harnessFailed, and saves nothing", async () => {
      const runner: HarnessRunner = {
        run: async ({ oneShot }) => {
          if (oneShot) return { stdout: "Nothing found.", firstByteMs: 1 }
          throw new Error("claude exited with code 1")
        },
      }
      const result = await runAiReview(depsWith(runner), userId, sessionId, {})
      expect(result).toMatchObject({ kind: "error", code: "harnessFailed" })
      expect(await db.select().from(sessionReviews)).toEqual([])
    })

    test("PR14: the reviewer sees only the session's alias, and the workspace is removed after", async () => {
      const { runner, seen } = problemsRunner(problemsMd("the build is fixed"))
      const result = await runAiReview(depsWith(runner), userId, sessionId, {})

      expect(result).toMatchObject({ kind: "ok" })
      expect(seen[0]?.prompt).not.toContain(sessionId)
      expect(seen[0]?.session).toMatchObject({ meta: { sessionId: "session-under-review" } })
      expect(createdDirs).toHaveLength(1)
      expect(existsSync(createdDirs[0] as string)).toBe(false)
    })

    test("PR15: the claude reviewer's transcript is captured from the workspace and saved on the run", async () => {
      const { runner } = problemsRunner(
        problemsMd("the build is fixed"),
        undefined,
        undefined,
        "",
        (workspaceDir) => {
          const projectDir = join(workspaceDir, "claude-config", "projects", "work")
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
        },
      )
      const result = await runAiReview(
        depsWith(runner, { env: { ...env, aiReviewHarness: "claude", aiReviewModel: "sonnet" } }),
        userId,
        sessionId,
        {},
      )
      expect(result).toMatchObject({ kind: "ok" })
      const signals = await persistedSignals()
      expect(signals).toMatchObject({ model: "sonnet", harness: "claude" })
      expect((signals.run as { transcript?: unknown }).transcript).toEqual([
        { role: "user", text: "review it" },
        {
          role: "assistant",
          text: "Done.",
          tools: [{ name: "Read", input: "/work/session.json" }],
        },
      ])
    })

    test("PR16: the opencode reviewer's transcript comes from the redirected XDG database", async () => {
      const { runner } = problemsRunner(
        problemsMd("the build is fixed"),
        undefined,
        undefined,
        "",
        (workspaceDir) => {
          const dataDir = join(workspaceDir, "xdg-data", "opencode")
          mkdirSync(dataDir, { recursive: true })
          const store = new Database(join(dataDir, "opencode.db"))
          store.exec(
            "CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, time_created INTEGER, time_updated INTEGER, agent TEXT, model TEXT, title TEXT)",
          )
          store.exec(
            "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)",
          )
          store.exec(
            "CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)",
          )
          store
            .prepare(
              "INSERT INTO session (id, parent_id, time_created, time_updated) VALUES ('rs1', NULL, 1, 5)",
            )
            .run()
          store
            .prepare(
              "INSERT INTO message (id, session_id, time_created, data) VALUES ('rm1', 'rs1', 2, ?)",
            )
            .run(JSON.stringify({ role: "user" }))
          store
            .prepare(
              "INSERT INTO part (id, message_id, session_id, time_created, data) VALUES ('rp1', 'rm1', 'rs1', 3, ?)",
            )
            .run(JSON.stringify({ type: "text", text: "review the export" }))
          store.close()
        },
      )
      const result = await runAiReview(depsWith(runner), userId, sessionId, {})
      expect(result).toMatchObject({ kind: "ok" })
      const run = (await persistedSignals()).run as { transcript?: unknown }
      expect(run.transcript).toEqual([{ role: "user", text: "review the export" }])
    })

    test("PR17: a harness with no credential is refused before any agent runs", async () => {
      const { runner, seen } = problemsRunner(problemsMd("the build is fixed"))
      const result = await runAiReview(
        // Configured for opencode, asked for claude, and only opencode has a key.
        depsWith(runner, { credentialEnv: { OPENCODE_API_KEY: "oc-key" } }),
        userId,
        sessionId,
        { harness: "claude" },
      )
      expect(result).toMatchObject({ kind: "error", code: "harnessUnauthenticated" })
      expect(seen).toHaveLength(0)
      expect(await db.select().from(sessionReviews)).toHaveLength(0)
    })

    test("PR18: the pipeline reports milestones through onMilestone, in order", async () => {
      const names: string[] = []
      const { runner } = problemsRunner(problemsMd("the build is fixed"))
      const result = await runAiReview(
        depsWith(runner, { onMilestone: (name) => names.push(name) }),
        userId,
        sessionId,
        {},
      )
      expect(result).toMatchObject({ kind: "ok" })
      // The hook is what the registry installs so a watching human sees where a run is; the
      // names and their order are the contract the CLI's progress line reads.
      expect(names.indexOf("readers_done")).toBeLessThan(names.indexOf("harness_spawning"))
      expect(names.indexOf("workspace_ready")).toBeLessThan(names.indexOf("harness_spawning"))
      expect(names.at(-1)).toBe("persisted")
    })

    test("PR19: an unknown session, or a viewer who cannot edit, is refused before any agent runs", async () => {
      const { runner, seen } = problemsRunner(problemsMd("the build is fixed"))
      expect(await runAiReview(depsWith(runner), userId, "does-not-exist", {})).toEqual({
        kind: "error",
        code: "sessionNotFound",
      })
      const [viewer] = await db
        .insert(users)
        .values({ githubId: 2, githubLogin: "viewer" })
        .returning({ id: users.id })
      await db.insert(userProjectGrant).values({
        userId: viewer?.id as string,
        projectId,
        scope: "viewer",
      })
      expect(await runAiReview(depsWith(runner), viewer?.id as string, sessionId, {})).toEqual({
        kind: "error",
        code: "notEditable",
      })
      expect(seen).toHaveLength(0)
    })
  })
})
