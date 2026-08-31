import { expect, test } from "vitest"
import type { IngestPayload, ParsedRecord } from "./index.js"

const records: ReadonlyArray<ParsedRecord> = [
  {
    lineUuid: "0191d942-3ba5-7dba-9a7d-22d65b30258c",
    lineNumber: 1,
    raw: {},
    messages: [
      {
        subIndex: 0,
        sessionId: "sess-1",
        source: "claude_code",
        sourceSchemaVersion: 1,
        trackId: "main",
        msgType: "custom",
        subType: "fixture",
      },
    ],
  },
]

const base = {
  sessionId: "sess-1",
  source: "claude_code" as const,
  project: { name: "widget", slug: "acme-widget" },
  sourceRelativePath: "sess-1.jsonl",
  records,
} as const

test("main payload narrows to type main, no agent block", () => {
  const payload = {
    ...base,
    type: "main",
    title: "hello",
  } satisfies IngestPayload

  if (payload.type !== "main") throw new Error("expected main")
  expect(payload.title).toBe("hello")
})

test("subagent payload narrows to agent", () => {
  const payload = {
    ...base,
    type: "subagent",
    agent: { agentId: "af66", agentType: "Explore" },
  } satisfies IngestPayload

  if (payload.type !== "subagent") throw new Error("expected subagent")
  expect(payload.agent.agentId).toBe("af66")
})
