import { describe, expect, test } from "vitest"
import type { NormalizedMessage } from "../ingest/types.js"
import { heuristicSessionAnalyzer } from "./analyzer.js"
import { reviewEventsFromMessages } from "./events.js"

/** A stored row projects with nulls where normalized messages carry undefined. */
const storedUserMessage = (overrides: Partial<Record<string, unknown>> = {}) =>
  ({
    subIndex: 0,
    sessionId: "s",
    source: "claude_code",
    sourceSchemaVersion: 1,
    trackId: "main",
    msgType: "message",
    role: "user",
    subType: null,
    timestamp: null,
    parentUuid: null,
    model: null,
    provider: null,
    agentId: null,
    cwd: null,
    repo: null,
    gitBranch: null,
    gitCommit: null,
    content: { type: "text", value: "fix the build" },
    details: null,
    ...overrides,
  }) as unknown as NormalizedMessage

describe("reviewEventsFromMessages on stored rows", () => {
  test("P1: subType null from a database row is a real prompt, not a meta injection", () => {
    const events = reviewEventsFromMessages([storedUserMessage()])
    const prompts = events.filter((event) => event.kind === "userMessage" && !event.isMeta)
    expect(prompts).toHaveLength(1)
  })

  test("P2: a non-null subType still marks the message meta", () => {
    const events = reviewEventsFromMessages([storedUserMessage({ subType: "compaction" })])
    const prompts = events.filter((event) => event.kind === "userMessage" && !event.isMeta)
    expect(prompts).toHaveLength(0)
  })

  test("P3: the analyzer counts the stored-row prompt in userPrompts", () => {
    const review = heuristicSessionAnalyzer.analyze({
      sessionId: "s",
      events: reviewEventsFromMessages([storedUserMessage()]),
    })
    expect(review.signals.userPrompts).toBe(1)
  })
})
