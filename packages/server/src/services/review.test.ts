import { describe, expect, test } from "vitest"
import type { MessageRow, SessionDetailRow } from "../repositories/sessions.repo.js"
import { reviewFromDetail } from "./review.js"

/** The projection `getDetail` returns: nulls where normalized messages carry undefined. */
const storedMessage = (overrides: Partial<MessageRow> = {}): MessageRow => ({
  id: "m0",
  msgType: "message",
  subType: null,
  role: "user",
  lineNumber: 1,
  subIndex: 0,
  trackId: "main",
  timestamp: null,
  agentId: null,
  isSubagent: false,
  model: null,
  content: { type: "text", value: "fix the build" },
  details: null,
  ...overrides,
})

const completedTurn = (lineNumber: number): MessageRow =>
  storedMessage({
    id: `turn-${lineNumber}`,
    msgType: "turnEvent",
    role: null,
    lineNumber,
    content: undefined,
    details: { type: "duration", status: "completed" },
  })

const abortedTurn = (lineNumber: number): MessageRow =>
  storedMessage({
    id: `abort-${lineNumber}`,
    msgType: "turnEvent",
    role: null,
    lineNumber,
    content: undefined,
    details: { type: "aborted", status: "aborted" },
  })

const detailWith = (overrides: Partial<SessionDetailRow> = {}): SessionDetailRow => ({
  session: {
    id: "s1",
    title: "fix the build",
    projectId: "p1",
    projectName: "widget",
    projectSlug: "acme-widget",
    userLogin: "octo",
    source: "claude_code",
    repo: { host: "github.com", owner: "acme", repoName: "widget" },
    durationMs: 1000,
    messageCount: 2,
    toolCallCount: 0,
    subagentCount: 0,
    lastActiveAt: "2026-08-26T00:00:00.000Z",
    startedAt: "2026-08-26T00:00:00.000Z",
  },
  messages: [storedMessage(), completedTurn(2)],
  toolCalls: [],
  subagents: [],
  tokenUsage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, thinkingTokens: 0 },
  commits: [],
  pullRequests: [],
  ...overrides,
})

const commitRow = (sha: string) => ({
  sha,
  branch: "main",
  subject: "fix the build",
  filesChanged: 2,
  insertions: 10,
  deletions: 1,
  messageId: "m0",
  recordedAt: "2026-08-26T00:00:01.000Z",
  repo: { host: "github.com", owner: "acme", repoName: "widget" },
})

const pullRequestRow = (number: number) => ({
  number,
  title: "Fix the build",
  baseBranch: "main",
  headBranch: "fix/build",
  messageId: "m0",
  recordedAt: "2026-08-26T00:00:01.000Z",
  repo: { host: "github.com", owner: "acme", repoName: "widget" },
})

describe("reviewFromDetail", () => {
  test("stored commits project into commit events and the outcome becomes shipped", () => {
    const review = reviewFromDetail(
      "s1",
      detailWith({ commits: [commitRow("abc123"), commitRow("def456")] }),
    )
    expect(review.signals.commits).toBe(2)
    expect(review.outcome).toBe("shipped")
  })

  test("stored pull requests project into pullRequest events and ship the session too", () => {
    const review = reviewFromDetail("s1", detailWith({ pullRequests: [pullRequestRow(42)] }))
    expect(review.signals.pullRequests).toBe(1)
    expect(review.outcome).toBe("shipped")
  })

  test("tokenUsage totals fold into the review so server-side reviews stop reporting zero tokens", () => {
    const review = reviewFromDetail(
      "s1",
      detailWith({
        tokenUsage: { inputTokens: 4321, outputTokens: 321, cachedTokens: 100, thinkingTokens: 50 },
      }),
    )
    expect(review.signals.inputTokens).toBe(4321)
    expect(review.signals.outputTokens).toBe(321)
    expect(review.signals.cachedTokens).toBe(100)
    expect(review.signals.thinkingTokens).toBe(50)
  })

  test("usage rows are dropped so the table totals, not the transcript lines, are counted once", () => {
    const review = reviewFromDetail(
      "s1",
      detailWith({
        messages: [
          storedMessage(),
          storedMessage({
            id: "u1",
            msgType: "usage",
            role: null,
            content: undefined,
            details: { type: "tokens", tokens: { input: 999, output: 99, cached: 9, thinking: 1 } },
          }),
          completedTurn(3),
        ],
        tokenUsage: { inputTokens: 4321, outputTokens: 321, cachedTokens: 100, thinkingTokens: 50 },
      }),
    )
    expect(review.signals.inputTokens).toBe(4321)
    expect(review.signals.outputTokens).toBe(321)
  })

  test("a session whose final turn aborted but which committed still ships", () => {
    const review = reviewFromDetail(
      "s1",
      detailWith({
        messages: [storedMessage(), completedTurn(2), abortedTurn(3)],
        commits: [commitRow("abc123")],
      }),
    )
    // The analyzer's precedence: an abort wins only when nothing landed, so landing evidence
    // overrides even a final aborted turn — "shipped" with the abort still visible in friction.
    expect(review.outcome).toBe("shipped")
  })

  test("a final aborted turn with nothing landed still reviews as aborted", () => {
    const review = reviewFromDetail(
      "s1",
      detailWith({ messages: [storedMessage(), completedTurn(2), abortedTurn(3)] }),
    )
    expect(review.outcome).toBe("aborted")
  })
})
