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

/** A tool call as either harness stores it: claude uses `file_path`, opencode `filePath`. */
const toolCall = (name: string, input: Record<string, unknown>) =>
  ({
    subIndex: 0,
    sessionId: "s",
    source: "opencode",
    sourceSchemaVersion: 1,
    trackId: "main",
    msgType: "toolCall",
    role: null,
    subType: null,
    timestamp: null,
    content: { type: "text", value: "" },
    details: { callId: `c-${name}`, name, input },
  }) as unknown as NormalizedMessage

describe("edit events across harnesses", () => {
  test("P4: opencode's lowercase write tools emit edit events", () => {
    const events = reviewEventsFromMessages([
      toolCall("write", { filePath: "src/a.ts" }),
      toolCall("edit", { filePath: "src/b.ts" }),
      toolCall("patch", { filePath: "src/c.ts" }),
    ])
    expect(events.filter((event) => event.kind === "edit").map((event) => event.path)).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
    ])
  })

  test("P5: claude's camelCase tools still emit edit events from file_path", () => {
    const events = reviewEventsFromMessages([toolCall("Edit", { file_path: "src/d.ts" })])
    expect(events.filter((event) => event.kind === "edit").map((event) => event.path)).toEqual([
      "src/d.ts",
    ])
  })

  test("P6: a non-write tool with a path emits no edit event", () => {
    const events = reviewEventsFromMessages([toolCall("Read", { file_path: "src/e.ts" })])
    expect(events.filter((event) => event.kind === "edit")).toHaveLength(0)
  })
})
