import { expect, test } from "vitest"
import { checkpointSchema } from "../collector/types.js"
import { ingestPayloadSchema } from "./types.js"

test("Codex uploads preserve native session context and every successful file effect", () => {
  const payload = {
    type: "main",
    source: "codex",
    sessionId: "thread-1",
    sourceRelativePath: "codex/thread-1",
    project: { name: "widget", slug: "acme-widget" },
    sourceContext: {
      startedAt: "2026-10-01T10:00:00Z",
      lastActiveAt: "2026-10-01T10:05:00Z",
      modelSnapshot: "test-model",
      provider: "openai",
    },
    records: [
      {
        lineUuid: "0191d942-3ba5-7dba-9a7d-22d65b30258c",
        lineNumber: 1,
        raw: {},
        messages: [
          {
            sessionId: "thread-1",
            source: "codex",
            sourceSchemaVersion: 1,
            trackId: "main",
            subIndex: 1,
            msgType: "toolResult",
            details: {
              callId: "codex:invocation-1",
              status: "success",
              output: {},
              metadata: {
                type: "writes",
                files: [
                  { path: "/work/a.ts", created: true },
                  { path: "/work/b.ts", created: false },
                ],
              },
            },
          },
        ],
      },
    ],
  }
  expect(ingestPayloadSchema.safeParse(payload)).toMatchObject({ success: true, data: payload })
})

test("Codex checkpoints retain ownership, the saved end and the unfinished items", () => {
  const checkpoint = {
    source: "codex",
    filePath: "codex:child",
    lastUpdatedAt: "2026-10-01T10:00:00Z",
    threadId: "child",
    sessionId: "root",
    metadataHash: "snapshot",
    updatedAt: 1_792_488_720,
    end: { turnId: "T2", itemId: "I7", ordinal: 8 },
    pending: [{ turnId: "T2", itemId: "I5", ordinal: 6, partial: true }],
  }
  expect(checkpointSchema.safeParse(checkpoint)).toMatchObject({ success: true, data: checkpoint })
})

test("a child upload can carry its explicit parent without weakening track validation", () => {
  const payload = {
    type: "subagent",
    source: "codex",
    sessionId: "root",
    sourceRelativePath: "codex/child",
    project: { name: "widget", slug: "acme-widget" },
    agent: { agentId: "child", parentAgentId: "parent" },
    records: [],
  }
  expect(ingestPayloadSchema.safeParse(payload)).toMatchObject({ success: true, data: payload })
})
