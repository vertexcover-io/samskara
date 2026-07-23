import { expect, test } from "vitest"
import type { IngestPayload } from "./index.js"

const base = {
  sessionId: "sess-1",
  sourceRelativePath: "sess-1.jsonl",
  project: { name: "widget", slug: "acme-widget" },
  rawLines: [{ lineUuid: "u1", raw: "{}" }],
  messages: [],
} as const

test("main payload narrows to session, not agent", () => {
  const payload = {
    ...base,
    type: "main",
    session: { model: "claude-opus-4-8" },
  } satisfies IngestPayload

  if (payload.type !== "main") throw new Error("expected main")
  expect(payload.session.model).toBe("claude-opus-4-8")
})

test("subagent payload narrows to agent, not session", () => {
  const payload = {
    ...base,
    type: "subagent",
    agent: { agentId: "af66", agentType: "Explore" },
  } satisfies IngestPayload

  if (payload.type !== "subagent") throw new Error("expected subagent")
  expect(payload.agent.agentId).toBe("af66")
})
