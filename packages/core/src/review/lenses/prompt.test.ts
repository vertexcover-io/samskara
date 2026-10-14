import { describe, expect, test } from "vitest"
import { buildReviewPrompt } from "./prompt.js"

const sessionMeta = {
  sessionId: "abc-123",
  title: "Fix the flaky ingest test",
  startedAt: "2026-08-25T09:00:00Z",
  endedAt: "2026-08-25T10:30:00Z",
  source: "opencode",
}

describe("buildReviewPrompt", () => {
  test("P1: frames the role, the session and the export", () => {
    const prompt = buildReviewPrompt({ sessionMeta })
    expect(prompt).toContain("You are reviewing a recorded AI coding session")
    expect(prompt).toContain(sessionMeta.sessionId)
    expect(prompt).toContain(sessionMeta.title)
    expect(prompt).toContain(sessionMeta.source)
    expect(prompt).toContain(sessionMeta.startedAt ?? "")
    expect(prompt).toContain(sessionMeta.endedAt ?? "")
  })

  test("P10: omits absent session timestamps rather than printing blanks", () => {
    const prompt = buildReviewPrompt({
      sessionMeta: { sessionId: "s", title: "t", source: "claude_code" },
    })
    expect(prompt).not.toContain("startedAt:")
    expect(prompt).not.toContain("endedAt:")
  })
})
