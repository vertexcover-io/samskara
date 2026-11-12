import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { mkdtemp as realMkdtemp } from "node:fs/promises"
import { join } from "node:path"
import type { HarnessRunner, NormalizedMessage } from "@samskara/core"
import { MAX_REVIEW_MD_BYTES } from "@samskara/core"
import Database from "better-sqlite3"
import { eq, sql } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest"
import { createDb, type Db } from "../../db/client.js"
import {
  messages,
  projects,
  reviewProblems as reviewProblemsTable,
  reviewReaderReplies,
  sessionReviews,
  sessions,
  tokenUsage,
  users,
} from "../../db/schema.js"
import { dockerAvailable, startTestDb } from "../../db/testDb.js"
import type { Env } from "../../lib/env.js"
import { captureLogger } from "../../lib/test-logger.js"
import { queueReview } from "../../repositories/workQueue.repo.js"
import { type AiReviewDeps, type ReviewRun, runAiReview } from "./pipeline.js"

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
  let dbUrl: string
  let teardown: () => Promise<void>

  beforeAll(async () => {
    const started = await startTestDb()
    db = started.db
    dbUrl = started.url
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

  /** A run as the worker hands it over: a row queued for the session, then claimed. */
  const queuedRun = async (): Promise<ReviewRun> => {
    const queued = await queueReview(db, {
      sessionId,
      projectId,
      analyzer: "ai-problems-v2",
      options: {},
    })
    // A run already waiting is one an earlier call left unfinished: running it again is its retry.
    const [waiting] =
      queued === null
        ? await db.select().from(sessionReviews).where(eq(sessionReviews.status, "waiting"))
        : [queued]
    if (waiting === undefined) throw new Error("no run to review")
    return { id: waiting.id, sessionId, newPartOnly: false, basedOn: null }
  }

  /** Runs saved with a result: a refused or failed run leaves none. */
  const doneRuns = () => db.select().from(sessionReviews).where(eq(sessionReviews.status, "done"))

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
        earlier?: string
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
            ...(has("earlier-review.md")
              ? { earlier: readFileSync(join(workspaceDir, "earlier-review.md"), "utf8") }
              : {}),
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
      const result = await runAiReview(depsWith(runner), await queuedRun(), {})

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

    test("SC10: an AI review is saved done on its queued row, with no error, read through the latest-timestamped message", async () => {
      const { runner } = problemsRunner(problemsMd("the build is fixed"))
      const run = await queuedRun()
      const result = await runAiReview(depsWith(runner), run, {})

      expect(result).toMatchObject({ kind: "ok", reviewId: run.id })
      const [latest] = await db
        .select({ id: messages.id })
        .from(messages)
        .where(eq(messages.timestamp, new Date(T0_PLUS_120S)))
      const [row] = await db
        .select()
        .from(sessionReviews)
        .where(eq(sessionReviews.sessionId, sessionId))
      expect(row).toMatchObject({ status: "done", error: null, lastMessageId: latest?.id })
    })

    test("PR2: a problem quoting what is not in the session is dropped, and the drop is recorded", async () => {
      const { runner } = problemsRunner(problemsMd("tests are all green"))
      const result = await runAiReview(depsWith(runner), await queuedRun(), {})

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
      const result = await runAiReview(depsWith(runner), await queuedRun(), {
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
      const result = await runAiReview(depsWith(runner), await queuedRun(), {
        prompt: "anything",
      })

      expect(result).toMatchObject({ kind: "error", code: "promptMergeFailed" })
      expect(seen).toHaveLength(1)
      expect(await doneRuns()).toEqual([])
    })

    test("PR5: a review.md that is not a review saves nothing", async () => {
      const { runner } = problemsRunner("not a review")
      const result = await runAiReview(depsWith(runner), await queuedRun(), {})

      expect(result).toMatchObject({ kind: "error", code: "unparseable" })
      expect(await doneRuns()).toEqual([])
    })

    test("PR6: an extra field the merged prompt asks for is required on every problem", async () => {
      const merged = "# How to review\n\n## Extra fields\n\n- topic: what the person asked about\n"
      const { runner } = problemsRunner(problemsMd("the build is fixed"), merged)
      const result = await runAiReview(depsWith(runner), await queuedRun(), {
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
        await expect(runAiReview(depsWith(runner), await queuedRun(), {})).rejects.toThrow()
      } finally {
        await db.execute(sql`drop trigger if exists fail_problem_trigger on "reviewProblems"`)
      }
      expect(await doneRuns()).toEqual([])
    })

    test("SC2: a second review is a new row with its own problems and recordIds, and the first reads back as before", async () => {
      const first = await runAiReview(
        depsWith(problemsRunner(problemsMd("the build is fixed")).runner),
        await queuedRun(),
        {},
      )
      const firstId = first.kind === "ok" ? first.reviewId : ""
      const before = await db.select().from(sessionReviews).where(eq(sessionReviews.id, firstId))
      const firstProblems = await savedProblems()

      const second = await runAiReview(
        depsWith(
          problemsRunner(
            problemsMd("the build is fixed").replace("Said the build", "Claimed the build"),
          ).runner,
        ),
        await queuedRun(),
        {},
      )

      expect(second).toMatchObject({ kind: "ok" })
      const secondId = second.kind === "ok" ? second.reviewId : ""
      expect(secondId).not.toBe(firstId)
      expect(await db.select().from(sessionReviews).where(eq(sessionReviews.id, firstId))).toEqual(
        before,
      )
      const problems = await savedProblems()
      expect(problems.filter((row) => row.reviewId === firstId)).toEqual(firstProblems)
      expect(problems.filter((row) => row.reviewId === secondId).map((row) => row.title)).toEqual([
        "Claimed the build was fixed after the tests failed",
      ])
      const [secondRow] = await db
        .select()
        .from(sessionReviews)
        .where(eq(sessionReviews.id, secondId))
      const recordIdsOf = (row: typeof secondRow) =>
        (row?.signals as { run?: { recordIds: unknown[] } } | undefined)?.run?.recordIds ?? []
      expect(recordIdsOf(secondRow).length).toBeGreaterThan(0)
      expect(recordIdsOf(secondRow)).toEqual(recordIdsOf(before[0]))
      expect((await doneRuns()).map((row) => row.id).sort()).toEqual([firstId, secondId].sort())
    })

    test("SC17: a new-part run reads the context and the new records only, saves its own row and the problem that touches new, and leaves the base run untouched", async () => {
      const lastRead = await db
        .select({ id: messages.id })
        .from(messages)
        .where(eq(messages.timestamp, new Date(T0_PLUS_120S)))
      const [base] = await db
        .insert(sessionReviews)
        .values({
          sessionId,
          projectId,
          analyzer: "ai-problems-v2",
          status: "done",
          outcome: "struggled",
          summary: "the earlier verdict",
          signals: { run: { recordIds: ["x"] } },
          lastMessageId: lastRead[0]?.id ?? null,
        })
        .returning()
      if (base === undefined) throw new Error("seed base failed")
      await db.insert(reviewProblemsTable).values({
        reviewId: base.id,
        sessionId,
        projectId,
        position: 0,
        title: "An earlier problem",
        class: "missed",
        severity: "low",
        severityReason: "r",
        fixType: "skill",
        description: "d",
        evidence: [],
        learning: "l",
      })
      const baseBefore = await db
        .select()
        .from(sessionReviews)
        .where(eq(sessionReviews.id, base.id))
      const later = (seconds: number) => new Date(T0_PLUS_120S + 300_000 + seconds * 1000)
      const newMessage = (trackId: string, lineNumber: number, value: string, at: Date) =>
        db
          .insert(messages)
          .values({
            sessionId,
            lineUuid: crypto.randomUUID(),
            subIndex: 0,
            msgType: "message",
            role: "assistant",
            lineNumber,
            trackId,
            raw: {},
            sourceSchemaVersion: 1,
            content: { type: "text", value },
            details: {},
            timestamp: at,
          })
          .returning({ id: messages.id })
      await newMessage("main", 5, "deploying now", later(0))
      // A subagent numbers its lines from 1, so it sorts first in the new part: msg-3.
      const [subagentLast] = await newMessage(
        "agent:a1",
        1,
        "skipped the migration check",
        later(1),
      )

      const queued = await queueReview(db, {
        sessionId,
        projectId,
        analyzer: "ai-problems-v2",
        options: {},
        basedOn: base.id,
      })
      const run = { id: queued?.id as string, sessionId, newPartOnly: true, basedOn: base.id }
      const reviewMd = `# Review

- **Outcome:** struggled

## Summary

The whole session, the earlier part and the deploy.

## Problems

### Skipped the migration check

- **Class:** missed
- **Severity:** high — a broken schema could ship
- **Fix type:** skill
- **Description:** The helper was expected to run the migration check. It skipped it.
- **Evidence:** msg-3 — "skipped the migration check" — this is wrong: the check never ran.
- **Learning:** Run the migration check before deploying.

### Said the build was fixed after the tests failed

- **Class:** missed
- **Severity:** high — a broken build would have shipped
- **Fix type:** skill
- **Description:** The agent was expected to rerun the tests. It said fixed.
- **Evidence:** msg-2 — "the build is fixed" — this is wrong: the only test run failed.
- **Learning:** Rerun the failing tests first.
`
      const { runner, seen } = problemsRunner(reviewMd)

      const result = await runAiReview(depsWith(runner), run, {})

      expect(result).toMatchObject({ kind: "ok", reviewId: run.id })
      const staged = seen.find((entry) => entry.session !== undefined)
      const records =
        (staged?.session as { records?: Array<{ id: string; text?: string }> } | undefined)
          ?.records ?? []
      expect(records.map((record) => record.id)).toEqual([
        "msg-0",
        "msg-1",
        "msg-2",
        "msg-3",
        "msg-4",
      ])
      expect(
        records
          .slice(3)
          .map((record) => record.text)
          .sort(),
      ).toEqual(["deploying now", "skipped the migration check"])
      expect(staged?.files).toContain("session.json")
      expect(staged?.earlier).toContain("Earlier outcome: struggled")
      expect(staged?.earlier).toContain("- An earlier problem")

      const [row] = await db.select().from(sessionReviews).where(eq(sessionReviews.id, run.id))
      expect(row).toMatchObject({
        status: "done",
        newPartOnly: true,
        basedOn: base.id,
        lastMessageId: subagentLast?.id,
      })
      expect(
        (row?.signals as { run?: { recordIds: unknown[] } } | undefined)?.run?.recordIds,
      ).toHaveLength(5)
      expect((row?.signals as { dropped?: string[] } | undefined)?.dropped).toEqual([
        `"Said the build was fixed after the tests failed": its evidence is all in the already-reviewed context`,
      ])
      const problems = await savedProblems()
      expect(problems.filter((p) => p.reviewId === run.id).map((p) => p.title)).toEqual([
        "Skipped the migration check",
      ])
      expect(problems.filter((p) => p.reviewId === base.id).map((p) => p.title)).toEqual([
        "An earlier problem",
      ])
      expect(await db.select().from(sessionReviews).where(eq(sessionReviews.id, base.id))).toEqual(
        baseBefore,
      )
    })

    test("a new-part run never moves the last message read back before its base's, even when the base ended on a row the export leaves out and the new messages have no time", async () => {
      // The base run ended on a custom line: later than every conversation message, and
      // left out of what a reviewer reads, so it is never among the context records.
      const [lastLine] = await db
        .insert(messages)
        .values({
          sessionId,
          lineUuid: crypto.randomUUID(),
          subIndex: 0,
          msgType: "custom",
          lineNumber: 5,
          raw: {},
          sourceSchemaVersion: 1,
          timestamp: new Date(T0_PLUS_120S + 60_000),
        })
        .returning({ id: messages.id })
      const [base] = await db
        .insert(sessionReviews)
        .values({
          sessionId,
          projectId,
          analyzer: "ai-problems-v2",
          status: "done",
          outcome: "productive",
          summary: "the earlier verdict",
          signals: {},
          lastMessageId: lastLine?.id ?? null,
          updatedAt: new Date(T0_PLUS_120S + 120_000),
        })
        .returning()
      if (base === undefined) throw new Error("seed base failed")
      // New, but with no time of its own: stored after the base run finished.
      await db.insert(messages).values({
        sessionId,
        lineUuid: crypto.randomUUID(),
        subIndex: 0,
        msgType: "message",
        role: "user",
        lineNumber: 6,
        raw: {},
        sourceSchemaVersion: 1,
        content: { type: "text", value: "now deploy it" },
        details: {},
        timestamp: null,
      })
      const queued = await queueReview(db, {
        sessionId,
        projectId,
        analyzer: "ai-problems-v2",
        options: {},
        basedOn: base.id,
      })
      const run = { id: queued?.id as string, sessionId, newPartOnly: true, basedOn: base.id }

      const result = await runAiReview(
        depsWith(problemsRunner(problemsMd("now deploy it")).runner),
        run,
        {},
      )

      expect(result).toMatchObject({ kind: "ok" })
      const [row] = await db.select().from(sessionReviews).where(eq(sessionReviews.id, run.id))
      expect(row?.lastMessageId).toBe(lastLine?.id)
    })

    test("a new-part run with no base run is sessionNotFound and saves no result", async () => {
      const queued = await queuedRun()
      const { runner } = problemsRunner(problemsMd("the build is fixed"))

      const result = await runAiReview(
        depsWith(runner),
        { ...queued, newPartOnly: true, basedOn: null },
        {},
      )

      expect(result).toEqual({ kind: "error", code: "sessionNotFound" })
      expect(await doneRuns()).toEqual([])
    })

    test("PR9: no review.md is deliverableMissing, and one past the size cap saves nothing", async () => {
      const missing: HarnessRunner = { run: async () => ({ stdout: "", firstByteMs: null }) }
      expect(await runAiReview(depsWith(missing), await queuedRun(), {})).toMatchObject({
        kind: "error",
        code: "deliverableMissing",
      })

      const huge = problemsMd("the build is fixed") + "x".repeat(MAX_REVIEW_MD_BYTES)
      const { runner } = problemsRunner(huge)
      expect(await runAiReview(depsWith(runner), await queuedRun(), {})).toMatchObject({
        kind: "error",
        code: "unparseable",
      })
      expect(await doneRuns()).toEqual([])
    })

    test("PR10: leads the review never answered are saved with it", async () => {
      const { runner } = problemsRunner(
        problemsMd("the build is fixed"),
        undefined,
        undefined,
        "- L1: dropped (no kind) — the opening request\n",
      )
      await runAiReview(depsWith(runner), await queuedRun(), {})
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
      await runAiReview(depsWith(runner), await queuedRun(), {})
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
      const result = await runAiReview(depsWith(runner), await queuedRun(), {})
      expect(result).toMatchObject({ kind: "error", code: "harnessFailed" })
      expect(await doneRuns()).toEqual([])
    })

    test("PR14: the reviewer sees only the session's alias, and the workspace is removed after", async () => {
      const { runner, seen } = problemsRunner(problemsMd("the build is fixed"))
      const result = await runAiReview(depsWith(runner), await queuedRun(), {})

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
        await queuedRun(),
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
      const result = await runAiReview(depsWith(runner), await queuedRun(), {})
      expect(result).toMatchObject({ kind: "ok" })
      const run = (await persistedSignals()).run as { transcript?: unknown }
      expect(run.transcript).toEqual([{ role: "user", text: "review the export" }])
    })

    test("PR17: a harness with no credential is refused before any agent runs", async () => {
      const { runner, seen } = problemsRunner(problemsMd("the build is fixed"))
      const result = await runAiReview(
        // Configured for opencode, asked for claude, and only opencode has a key.
        depsWith(runner, { credentialEnv: { OPENCODE_API_KEY: "oc-key" } }),
        await queuedRun(),
        { harness: "claude" },
      )
      expect(result).toMatchObject({ kind: "error", code: "harnessUnauthenticated" })
      expect(seen).toHaveLength(0)
      expect(await doneRuns()).toEqual([])
    })

    test("PR18: the pipeline reports milestones through onMilestone, in order", async () => {
      const names: string[] = []
      const { runner } = problemsRunner(problemsMd("the build is fixed"))
      const result = await runAiReview(
        depsWith(runner, { onMilestone: (name) => names.push(name) }),
        await queuedRun(),
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
      expect(
        await runAiReview(
          depsWith(runner),
          {
            id: crypto.randomUUID(),
            sessionId: "does-not-exist",
            newPartOnly: false,
            basedOn: null,
          },
          {},
        ),
      ).toEqual({
        kind: "error",
        code: "sessionNotFound",
      })
      expect(seen).toHaveLength(0)
    })

    describe("reader replies kept across tries of one review", () => {
      /** One lead per piece, each quoting its own piece, so leads.md shows which pieces were read. */
      const READER_REPLIES: Readonly<Record<string, string>> = {
        "main, part 1": '- msg-2 — "the build is fixed" — said before any test was rerun',
        "helper agent:a": '- msg-3 — "helper a read the logs" — read the logs, fixed nothing',
        "helper agent:b": '- msg-4 — "helper b ran the linter" — ran the linter, not the tests',
      }

      /** Stores one message on a helper track, after the fixture's four. */
      const addHelperMessage = async (track: string, line: number, text: string) => {
        await db.insert(messages).values({
          sessionId,
          lineUuid: crypto.randomUUID(),
          subIndex: 0,
          msgType: "message",
          role: "assistant",
          lineNumber: line,
          source: "claude_code",
          sourceRelativePath: "test.jsonl",
          trackId: track,
          raw: {},
          sourceSchemaVersion: 1,
          content: { type: "text", value: text },
          details: {},
          timestamp: new Date(T0_PLUS_120S + line * 1000),
        })
      }

      /** The session in three pieces, and a running review run on its first try. */
      const threePieceReview = async (): Promise<ReviewRun> => {
        await addHelperMessage("agent:a", 5, "helper a read the logs")
        await addHelperMessage("agent:b", 6, "helper b ran the linter")
        const [row] = await db
          .insert(sessionReviews)
          .values({
            sessionId,
            projectId,
            analyzer: "ai-problems-v2",
            status: "running",
            attempts: 1,
          })
          .returning({ id: sessionReviews.id })
        if (row === undefined) throw new Error("seed review failed")
        return { id: row.id, sessionId, newPartOnly: false, basedOn: null }
      }

      /**
       * One try's agents: each reader call is recorded by its piece, `failReader` names a piece
       * whose reader throws, and the reviewer throws when `reviewerFails`.
       */
      const tryRunner = (opts: {
        readonly failReader?: string
        readonly reviewerFails?: boolean
      }) => {
        const readers: string[] = []
        const reviewerLeads: string[] = []
        let reviewerCalls = 0
        const runner: HarnessRunner = {
          run: async ({ workspaceDir, oneShot, prompt }) => {
            if (oneShot) {
              const piece = /# The piece: (.+)/.exec(prompt)?.[1] ?? "?"
              readers.push(piece)
              if (piece === opts.failReader) throw new Error("harness run timed out")
              return { stdout: READER_REPLIES[piece] ?? "Nothing found.", firstByteMs: 1 }
            }
            reviewerCalls += 1
            if (opts.reviewerFails === true) throw new Error("reviewer crashed")
            reviewerLeads.push(readFileSync(join(workspaceDir, "leads.md"), "utf8"))
            writeFileSync(join(workspaceDir, "review.md"), problemsMd("the build is fixed"))
            writeFileSync(join(workspaceDir, "leads-answered.md"), "")
            return { stdout: "review.md ready", firstByteMs: 1 }
          },
        }
        return { runner, readers, reviewerLeads, reviewerCalls: () => reviewerCalls }
      }

      const readersDone = (lines: ReadonlyArray<Record<string, unknown>>) =>
        lines.find((line) => line.milestone === "readers_done")

      test("SC401: a retry after one reader failed calls the model only for that reader, then the reviewer", async () => {
        const run = await threePieceReview()
        const first = tryRunner({ failReader: "helper agent:b", reviewerFails: true })
        expect(await runAiReview(depsWith(first.runner), run)).toMatchObject({
          kind: "error",
          code: "harnessFailed",
        })
        expect([...first.readers].sort()).toEqual([
          "helper agent:a",
          "helper agent:b",
          "main, part 1",
        ])

        const second = tryRunner({})
        expect(await runAiReview(depsWith(second.runner), run)).toMatchObject({
          kind: "ok",
        })
        expect(second.readers).toEqual(["helper agent:b"])
        expect(second.reviewerCalls()).toBe(1)
        const leads = second.reviewerLeads[0] ?? ""
        for (const quote of [
          "the build is fixed",
          "helper a read the logs",
          "helper b ran the linter",
        ])
          expect(leads).toContain(quote)
      })

      test("SC402: replies saved by one try are reused by a try on a new database connection, as after a worker restart", async () => {
        const run = await threePieceReview()
        const first = tryRunner({ reviewerFails: true })
        await runAiReview(depsWith(first.runner), run)
        expect(first.readers).toHaveLength(3)

        const restarted = createDb(dbUrl)
        try {
          const second = tryRunner({})
          const captured = captureLogger()
          const result = await runAiReview(
            depsWith(second.runner, { db: restarted.db, log: captured.log }),
            run,
          )
          expect(result).toMatchObject({ kind: "ok" })
          expect(second.readers).toEqual([])
          expect(readersDone(captured.lines)).toMatchObject({ pieces: 3, reused: 3 })
        } finally {
          await restarted.client.end()
        }
      })

      test("SC403: a message added to one piece between tries reruns only that piece's reader", async () => {
        const run = await threePieceReview()
        await runAiReview(depsWith(tryRunner({ reviewerFails: true }).runner), run)
        await addHelperMessage("agent:a", 7, "helper a restarted the service")

        const second = tryRunner({})
        expect(await runAiReview(depsWith(second.runner), run)).toMatchObject({
          kind: "ok",
        })
        expect(second.readers).toEqual(["helper agent:a"])
      })

      test("SC410: a review saved done leaves no saved replies on its row", async () => {
        const run = await threePieceReview()
        const repliesOnRow = async () =>
          db.select().from(reviewReaderReplies).where(eq(reviewReaderReplies.reviewId, run.id))
        await runAiReview(depsWith(tryRunner({ reviewerFails: true }).runner), run)
        expect(await repliesOnRow()).toHaveLength(3)

        const second = tryRunner({})
        expect(await runAiReview(depsWith(second.runner), run)).toMatchObject({
          kind: "ok",
        })
        const [row] = await db.select().from(sessionReviews).where(eq(sessionReviews.id, run.id))
        expect(row?.status).toBe("done")
        expect(await repliesOnRow()).toEqual([])
      })

      test("SC408: a reply that cannot be saved is logged, and the review still uses the reader's leads", async () => {
        const run = await threePieceReview()
        const agents = tryRunner({})
        const captured = captureLogger()
        // Every insert into the replies table is refused, as a lost connection would.
        await db.execute(
          sql`alter table "reviewReaderReplies" add constraint "refuseAll" check (false) not valid`,
        )
        try {
          const result = await runAiReview(depsWith(agents.runner, { log: captured.log }), run)
          expect(result).toMatchObject({ kind: "ok" })
        } finally {
          await db.execute(sql`alter table "reviewReaderReplies" drop constraint "refuseAll"`)
        }
        expect(
          captured.at("warn").filter((line) => line.msg === "a reader reply could not be saved"),
        ).toHaveLength(3)
        expect(agents.reviewerLeads[0]).toContain("helper b ran the linter")
      })
    })
  })
})
