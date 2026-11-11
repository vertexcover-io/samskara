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
  learningRuns,
  learnings,
  messages,
  projects,
  reviewProblems as reviewProblemsTable,
  sessionReviews,
  sessions,
  tokenUsage,
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
    await db.delete(learnings)
    await db.delete(learningRuns)
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
      const result = await runAiReview(depsWith(runner), sessionId, {})

      expect(result).toMatchObject({ kind: "ok" })
      expect(seen[0]?.files).toEqual(["session.json", "leads.md", "CONTRACT.md"])
      const [row] = await db
        .select()
        .from(sessionReviews)
        .where(eq(sessionReviews.sessionId, sessionId))
      expect(row).toMatchObject({
        analyzer: "ai-problems-v2",
        outcome: "struggled",
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

    test("SC10: an AI review is saved done, with no error, through the highest line seeded", async () => {
      const { runner } = problemsRunner(problemsMd("the build is fixed"))
      const result = await runAiReview(depsWith(runner), sessionId, {})

      expect(result).toMatchObject({ kind: "ok" })
      const lastSeeded = Math.max(...normalizedFixtures.map((message) => message.subIndex + 1))
      const [row] = await db
        .select()
        .from(sessionReviews)
        .where(eq(sessionReviews.sessionId, sessionId))
      expect(row).toMatchObject({ status: "done", error: null, reviewedThrough: lastSeeded })
    })

    test("PR2: a problem quoting what is not in the session is dropped, and the drop is recorded", async () => {
      const { runner } = problemsRunner(problemsMd("tests are all green"))
      const result = await runAiReview(depsWith(runner), sessionId, {})

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
      const result = await runAiReview(depsWith(runner), sessionId, {
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
      const result = await runAiReview(depsWith(runner), sessionId, {
        prompt: "anything",
      })

      expect(result).toMatchObject({ kind: "error", code: "promptMergeFailed" })
      expect(seen).toHaveLength(1)
      expect(await db.select().from(sessionReviews)).toEqual([])
    })

    test("PR5: a review.md that is not a review saves nothing", async () => {
      const { runner } = problemsRunner("not a review")
      const result = await runAiReview(depsWith(runner), sessionId, {})

      expect(result).toMatchObject({ kind: "error", code: "unparseable" })
      expect(await db.select().from(sessionReviews)).toEqual([])
    })

    test("PR6: an extra field the merged prompt asks for is required on every problem", async () => {
      const merged = "# How to review\n\n## Extra fields\n\n- topic: what the person asked about\n"
      const { runner } = problemsRunner(problemsMd("the build is fixed"), merged)
      const result = await runAiReview(depsWith(runner), sessionId, {
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
        await expect(runAiReview(depsWith(runner), sessionId, {})).rejects.toThrow()
      } finally {
        await db.execute(sql`drop trigger if exists fail_problem_trigger on "reviewProblems"`)
      }
      expect(await db.select().from(sessionReviews)).toEqual([])
    })

    test("PR8: a redo keeps the review's id and replaces its problems", async () => {
      const first = await runAiReview(
        depsWith(problemsRunner(problemsMd("the build is fixed")).runner),
        sessionId,
        {},
      )
      const second = await runAiReview(
        depsWith(
          problemsRunner(
            problemsMd("the build is fixed").replace("Said the build", "Claimed the build"),
          ).runner,
        ),
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

    describe("a re-review of a session with new messages", () => {
      /** Stores messages after the fixture's four, on the main track unless said. */
      const addMessages = async (
        rows: ReadonlyArray<{
          readonly line: number
          readonly msgType?: "message" | "turnEvent"
          readonly role?: "user" | "assistant"
          readonly text?: string
        }>,
      ) => {
        for (const row of rows) {
          const msgType = row.msgType ?? "message"
          await db.insert(messages).values({
            sessionId,
            lineUuid: crypto.randomUUID(),
            subIndex: 0,
            msgType,
            role: msgType === "message" ? (row.role ?? "assistant") : null,
            lineNumber: row.line,
            source: "claude_code",
            sourceRelativePath: "test.jsonl",
            trackId: "main",
            raw: {},
            sourceSchemaVersion: 1,
            content: msgType === "message" ? { type: "text", value: row.text ?? "" } : null,
            details: {},
          })
        }
      }

      const newMessages = [
        { line: 5, role: "user", text: "now deploy it to staging" },
        { line: 6, text: "deployed to staging without running the smoke tests" },
        { line: 7, text: "all done here" },
      ] as const

      const deployMd = `# Review

- **Outcome:** shipped

## Summary

The agent fixed the build, then deployed it without the smoke tests.

## Problems

### Deployed without running the smoke tests

- **Class:** missed
- **Severity:** high — a broken deploy would have reached staging
- **Fix type:** skill
- **Description:** The agent was expected to run the smoke tests before deploying. It deployed without them.
- **Evidence:** msg-4 — "deployed to staging without running the smoke tests" — this is wrong: no smoke test ran first.
- **Learning:** Run the smoke tests and read the result before deploying.
- **Extra:** stage: coder
`

      /**
       * A full review over the fixture's four messages, whose one problem a fix run has
       * grouped into a learning. Returns the review row and the message ids it numbered.
       */
      const earlierPass = async () => {
        const first = await runAiReview(
          depsWith(problemsRunner(problemsMd("the build is fixed")).runner),
          sessionId,
          {},
        )
        if (first.kind !== "ok") throw new Error("the earlier pass failed")
        const [run] = await db
          .insert(learningRuns)
          .values({ projectId, status: "done" })
          .returning({ id: learningRuns.id })
        const [learning] = await db
          .insert(learnings)
          .values({
            projectId,
            updatedByRunId: run?.id as string,
            title: "Rerun failed tests",
            cause: "c",
            problem: "p",
            priority: "low",
            priorityReason: "r",
            fixType: "skill",
            fix: "f",
          })
          .returning({ id: learnings.id })
        await db
          .update(reviewProblemsTable)
          .set({ learningRunId: run?.id as string, learningId: learning?.id as string })
          .where(eq(reviewProblemsTable.reviewId, first.reviewId))
        const [oldProblem] = await savedProblems()
        const recordIds = ((await persistedSignals()).run as { recordIds: string[] }).recordIds
        return { reviewId: first.reviewId, recordIds, oldProblem }
      }

      const reviewRow = async () => {
        const [row] = await db
          .select()
          .from(sessionReviews)
          .where(eq(sessionReviews.sessionId, sessionId))
        return row
      }

      const recordsSeen = (session: unknown) =>
        (session as { records: Array<{ id: string; text?: string }> }).records

      test("SC16: a re-review reads the old records as context plus the new ones, and adds its problem after the old one", async () => {
        const earlier = await earlierPass()
        expect(earlier.recordIds).toHaveLength(3)
        await addMessages(newMessages)
        const { runner, seen } = problemsRunner(deployMd)

        const result = await runAiReview(depsWith(runner), sessionId, { newPartOnly: true })

        expect(result).toMatchObject({ kind: "ok", reviewId: earlier.reviewId })
        const reviewer = seen.find((entry) => entry.session !== undefined)
        expect(recordsSeen(reviewer?.session).map((record) => record.id)).toEqual([
          "msg-0",
          "msg-1",
          "msg-2",
          "msg-3",
          "msg-4",
          "msg-5",
        ])
        expect(recordsSeen(reviewer?.session)[4]?.text).toContain("deployed to staging")
        expect(reviewer?.contract?.startsWith("## Already reviewed")).toBe(true)
        expect(reviewer?.contract).toContain("Said the build was fixed after the tests failed")
        expect(reviewer?.contract).toContain(
          "The agent claimed the build was fixed after the tests failed.",
        )
        const problems = (await savedProblems()).sort((a, b) => a.position - b.position)
        expect(problems).toHaveLength(2)
        expect(problems[0]).toEqual(earlier.oldProblem)
        expect(problems[0]?.learningId).not.toBeNull()
        expect(problems[1]).toMatchObject({
          position: 1,
          title: "Deployed without running the smoke tests",
          reviewId: earlier.reviewId,
        })
        expect(await reviewRow()).toMatchObject({
          reviewedThrough: 7,
          outcome: "shipped",
          summary: "The agent fixed the build, then deployed it without the smoke tests.",
        })
        const signals = (await persistedSignals()) as {
          newPartFrom?: string
          run: { recordIds: Array<string | null> }
        }
        expect(signals.run.recordIds.slice(0, 3)).toEqual(earlier.recordIds)
        expect(signals.run.recordIds).toHaveLength(6)
        expect(signals.newPartFrom).toBe("msg-3")
      })

      test("SC17: only a bookkeeping line since the review moves reviewedThrough without running the reviewer", async () => {
        const earlier = await earlierPass()
        const before = await reviewRow()
        await addMessages([{ line: 5, msgType: "turnEvent" }])
        const { runner, seen } = problemsRunner(deployMd)

        const result = await runAiReview(depsWith(runner), sessionId, { newPartOnly: true })

        expect(result).toMatchObject({ kind: "ok", reviewId: earlier.reviewId })
        expect(seen).toHaveLength(0)
        expect(await reviewRow()).toMatchObject({
          status: "done",
          reviewedThrough: 5,
          outcome: before?.outcome,
          summary: before?.summary,
        })
        expect(await savedProblems()).toEqual([earlier.oldProblem])
      })

      test("a tool result stored after the review is read: its call comes back as a new record and its problem is kept", async () => {
        // The first pass runs while the test run (msg-1) has no result yet.
        await db.delete(messages).where(eq(messages.msgType, "toolResult"))
        const earlier = await earlierPass()
        await db.insert(messages).values({
          sessionId,
          lineUuid: crypto.randomUUID(),
          subIndex: 0,
          msgType: "toolResult",
          lineNumber: 5,
          source: "claude_code",
          sourceRelativePath: "test.jsonl",
          trackId: "main",
          raw: {},
          sourceSchemaVersion: 1,
          details: { callId: "call-0", output: "3 tests failed", status: "failure" },
        })
        const failedRunMd = deployMd
          .replace("Deployed without running the smoke tests", "Ignored the failed test run")
          .replace(
            'msg-4 — "deployed to staging without running the smoke tests"',
            'msg-3 — "3 tests failed"',
          )
        const { runner, seen } = problemsRunner(failedRunMd)

        const result = await runAiReview(depsWith(runner), sessionId, { newPartOnly: true })

        expect(result).toMatchObject({ kind: "ok", reviewId: earlier.reviewId })
        const reviewer = seen.find((entry) => entry.session !== undefined)
        expect(recordsSeen(reviewer?.session).at(-1)).toMatchObject({
          id: "msg-3",
          msgType: "toolCall",
          status: "failure",
        })
        expect((await savedProblems()).map((row) => row.title)).toEqual([
          earlier.oldProblem?.title,
          "Ignored the failed test run",
        ])
        expect((await reviewRow())?.reviewedThrough).toBe(5)
      })

      test("a subagent's tool call reviewed before its result arrived is read again once the result is stored, though its line number is below reviewedThrough", async () => {
        // The first pass reads the call on a subagent track with no result yet.
        await db.delete(messages).where(eq(messages.msgType, "toolResult"))
        await db
          .update(messages)
          .set({ trackId: "agent:a1", lineNumber: 1 })
          .where(eq(messages.msgType, "toolCall"))
        const earlier = await earlierPass()
        await db.insert(messages).values({
          sessionId,
          lineUuid: crypto.randomUUID(),
          subIndex: 0,
          msgType: "toolResult",
          lineNumber: 2,
          source: "claude_code",
          sourceRelativePath: "test.jsonl",
          trackId: "agent:a1",
          raw: {},
          sourceSchemaVersion: 1,
          details: { callId: "call-0", output: "3 tests failed", status: "failure" },
        })
        const failedRunMd = deployMd
          .replace("Deployed without running the smoke tests", "Ignored the failed test run")
          .replace(
            'msg-4 — "deployed to staging without running the smoke tests"',
            'msg-3 — "3 tests failed"',
          )
        const { runner, seen } = problemsRunner(failedRunMd)

        const result = await runAiReview(depsWith(runner), sessionId, { newPartOnly: true })

        expect(result).toMatchObject({ kind: "ok", reviewId: earlier.reviewId })
        const reviewer = seen.find((entry) => entry.session !== undefined)
        expect(recordsSeen(reviewer?.session).at(-1)).toMatchObject({
          id: "msg-3",
          msgType: "toolCall",
          track: "agent:a1",
          status: "failure",
        })
        expect((await savedProblems()).map((row) => row.title)).toEqual([
          earlier.oldProblem?.title,
          "Ignored the failed test run",
        ])
      })

      test("SC18: a review marked new-part-only with no earlier result reads the whole session", async () => {
        await db.insert(sessionReviews).values({
          sessionId,
          projectId,
          analyzer: "ai-problems-v2",
          status: "running",
          attempts: 1,
          newPartOnly: true,
        })
        const { runner, seen } = problemsRunner(problemsMd("the build is fixed"))

        const result = await runAiReview(depsWith(runner), sessionId, { newPartOnly: true })

        expect(result).toMatchObject({ kind: "ok" })
        const reviewer = seen.find((entry) => entry.session !== undefined)
        expect(recordsSeen(reviewer?.session).map((record) => record.id)).toEqual([
          "msg-0",
          "msg-1",
          "msg-2",
        ])
        expect(reviewer?.contract).not.toContain("## Already reviewed")
        expect(await savedProblems()).toHaveLength(1)
        expect((await reviewRow())?.reviewedThrough).toBe(4)
      })

      test("a review marked new-part-only whose earlier result kept no record order reads the whole session and replaces the problems", async () => {
        await earlierPass()
        // Saved before reviews kept signals.run.recordIds.
        await db
          .update(sessionReviews)
          .set({ signals: {} })
          .where(eq(sessionReviews.sessionId, sessionId))
        await addMessages(newMessages)
        const { runner, seen } = problemsRunner(deployMd)

        const result = await runAiReview(depsWith(runner), sessionId, { newPartOnly: true })

        expect(result).toMatchObject({ kind: "ok" })
        const reviewer = seen.find((entry) => entry.session !== undefined)
        expect(recordsSeen(reviewer?.session)).toHaveLength(6)
        expect(reviewer?.contract).not.toContain("## Already reviewed")
        expect((await savedProblems()).map((row) => row.title)).toEqual([
          "Deployed without running the smoke tests",
        ])
        expect((await reviewRow())?.reviewedThrough).toBe(7)
      })

      test("SC19: a redo without the mark reads the whole session and replaces the problems", async () => {
        await earlierPass()
        await addMessages(newMessages)
        const { runner, seen } = problemsRunner(deployMd)

        const result = await runAiReview(depsWith(runner), sessionId, {})

        expect(result).toMatchObject({ kind: "ok" })
        const reviewer = seen.find((entry) => entry.session !== undefined)
        expect(recordsSeen(reviewer?.session)[0]?.id).toBe("msg-0")
        expect(recordsSeen(reviewer?.session)).toHaveLength(6)
        expect(reviewer?.contract).not.toContain("## Already reviewed")
        expect((await savedProblems()).map((row) => row.title)).toEqual([
          "Deployed without running the smoke tests",
        ])
      })
    })

    test("PR9: no review.md is deliverableMissing, and one past the size cap saves nothing", async () => {
      const missing: HarnessRunner = { run: async () => ({ stdout: "", firstByteMs: null }) }
      expect(await runAiReview(depsWith(missing), sessionId, {})).toMatchObject({
        kind: "error",
        code: "deliverableMissing",
      })

      const huge = problemsMd("the build is fixed") + "x".repeat(MAX_REVIEW_MD_BYTES)
      const { runner } = problemsRunner(huge)
      expect(await runAiReview(depsWith(runner), sessionId, {})).toMatchObject({
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
      await runAiReview(depsWith(runner), sessionId, {})
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
      await runAiReview(depsWith(runner), sessionId, {})
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
      const result = await runAiReview(depsWith(runner), sessionId, {})
      expect(result).toMatchObject({ kind: "error", code: "harnessFailed" })
      expect(await db.select().from(sessionReviews)).toEqual([])
    })

    test("PR14: the reviewer sees only the session's alias, and the workspace is removed after", async () => {
      const { runner, seen } = problemsRunner(problemsMd("the build is fixed"))
      const result = await runAiReview(depsWith(runner), sessionId, {})

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
      const result = await runAiReview(depsWith(runner), sessionId, {})
      expect(result).toMatchObject({ kind: "ok" })
      const run = (await persistedSignals()).run as { transcript?: unknown }
      expect(run.transcript).toEqual([{ role: "user", text: "review the export" }])
    })

    test("PR17: a harness with no credential is refused before any agent runs", async () => {
      const { runner, seen } = problemsRunner(problemsMd("the build is fixed"))
      const result = await runAiReview(
        // Configured for opencode, asked for claude, and only opencode has a key.
        depsWith(runner, { credentialEnv: { OPENCODE_API_KEY: "oc-key" } }),
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

    test("PR19: an unknown session is refused before any agent runs", async () => {
      const { runner, seen } = problemsRunner(problemsMd("the build is fixed"))
      expect(await runAiReview(depsWith(runner), "does-not-exist", {})).toEqual({
        kind: "error",
        code: "sessionNotFound",
      })
      expect(seen).toHaveLength(0)
    })
  })
})
