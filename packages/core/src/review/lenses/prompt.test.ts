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

  test("P2: names the three workspace files and defers to CONTRACT.md", () => {
    const prompt = buildReviewPrompt({ sessionMeta })
    expect(prompt).toContain("CONTRACT.md")
    expect(prompt).toContain("Read it first")
    expect(prompt).toContain("session.json")
    expect(prompt).toContain("review.xml")
  })

  test("P3: the file is the deliverable, never a one-shot reply", () => {
    const prompt = buildReviewPrompt({ sessionMeta })
    expect(prompt).toContain("The file is the deliverable")
    expect(prompt).toContain("never emit the whole review in one message")
    expect(prompt).toContain("one well-formed element at a time")
    expect(prompt).toContain('e.g. "review.xml ready')
  })

  test("P4: stays lean - the contract itself is not embedded in the prompt", () => {
    const prompt = buildReviewPrompt({ sessionMeta })
    expect(prompt).not.toContain("<?xml")
    expect(prompt).not.toContain("xmllint")
    // Enum definitions live in CONTRACT.md, not the prompt.
    expect(prompt).not.toContain("useful work, nothing delivered")
    expect(prompt).not.toContain("<timeline>")
  })

  test("P5: judges the session in session.json, not the reviewing task or transcript talk", () => {
    const prompt = buildReviewPrompt({ sessionMeta })
    expect(prompt).toContain("not the task of reviewing")
    expect(prompt).toContain("not any session the transcript merely talks about")
  })

  test("P9: is deterministic for the same input", () => {
    expect(buildReviewPrompt({ sessionMeta })).toBe(buildReviewPrompt({ sessionMeta }))
  })

  test("P10: omits absent session timestamps rather than printing blanks", () => {
    const prompt = buildReviewPrompt({
      sessionMeta: { sessionId: "s", title: "t", source: "claude_code" },
    })
    expect(prompt).not.toContain("startedAt:")
    expect(prompt).not.toContain("endedAt:")
  })
})
