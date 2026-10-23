import { describe, expect, test } from "vitest"
import type { NormalizedMessage } from "../ingest/types.js"
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
  test.each([
    {
      id: "P1",
      subType: null,
      prompts: 1,
      label: "a null subType from a database row is a real prompt",
    },
    {
      id: "P2",
      subType: "compaction",
      prompts: 0,
      label: "a non-null subType marks the message meta",
    },
  ])("$id: $label", ({ subType, prompts }) => {
    const events = reviewEventsFromMessages([storedUserMessage({ subType })])
    const real = events.filter((event) => event.kind === "userMessage" && !event.isMeta)
    expect(real).toHaveLength(prompts)
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
  test("Codex successful patch effects count every edited file", () => {
    const result: NormalizedMessage = {
      subIndex: 1,
      sessionId: "s",
      source: "codex",
      sourceSchemaVersion: 1,
      trackId: "main",
      msgType: "toolResult",
      details: {
        callId: "patch",
        status: "success",
        output: "done",
        metadata: {
          type: "writes",
          files: [
            { path: "a.ts", created: false },
            { path: "b.ts", created: true },
          ],
        },
      },
    }
    expect(reviewEventsFromMessages([result]).filter((event) => event.kind === "edit")).toEqual([
      { seq: 1, kind: "edit", path: "a.ts" },
      { seq: 2, kind: "edit", path: "b.ts" },
    ])
  })
  test.each([
    {
      id: "P4",
      label: "opencode's lowercase write tools emit edits from filePath",
      calls: [
        toolCall("write", { filePath: "src/a.ts" }),
        toolCall("edit", { filePath: "src/b.ts" }),
        toolCall("patch", { filePath: "src/c.ts" }),
      ],
      paths: ["src/a.ts", "src/b.ts", "src/c.ts"],
    },
    {
      id: "P5",
      label: "claude's camelCase Edit emits an edit from file_path",
      calls: [toolCall("Edit", { file_path: "src/d.ts" })],
      paths: ["src/d.ts"],
    },
    {
      id: "P6",
      label: "a non-write tool with a path emits no edit",
      calls: [toolCall("Read", { file_path: "src/e.ts" })],
      paths: [],
    },
  ])("$id: $label", ({ calls, paths }) => {
    const events = reviewEventsFromMessages(calls)
    expect(events.filter((event) => event.kind === "edit").map((event) => event.path)).toEqual(
      paths,
    )
  })
})
