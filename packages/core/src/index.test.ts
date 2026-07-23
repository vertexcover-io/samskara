import { expect, test } from "vitest"
import type { IngestPayload, ParsedRecord } from "./index.js"

const records: ReadonlyArray<ParsedRecord> = [
  { lineUuid: "u1", lineNumber: 1, raw: "{}", messages: [] },
]

const base = {
  sessionId: "sess-1",
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
