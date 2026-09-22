import { describe, expect, test } from "vitest"
import {
  type KnowledgeLesson,
  knowledgeIndexFromLessons,
  lessonSlug,
  renderKnowledgeLesson,
  renderLearningsMarkdown,
} from "./exporters.js"
import { fingerprintOf } from "./extractor.js"
import type { LearningCandidate } from "./types.js"

const learning = (overrides: Partial<LearningCandidate> = {}): LearningCandidate => ({
  audience: "agent",
  category: "tool-retry",
  title: "Bash failed 3 times in a row",
  detail: "After the second failure of the same call shape, change the approach.",
  evidence: [{ seq: 4, what: "failure 1 of Bash" }],
  fingerprint: fingerprintOf("agent", "tool-retry", "Bash"),
  ...overrides,
})

describe("renderLearningsMarkdown", () => {
  test("E1: renders a header plus one section per learning, agent learnings before human feedback", () => {
    const markdown = renderLearningsMarkdown({
      projectName: "samskara",
      generatedAt: new Date("2026-08-25T12:00:00Z"),
      learnings: [
        learning(),
        learning({
          audience: "human",
          category: "supervision",
          title: "2 prompts arrived while errors were piling up",
          detail: "State failure handling in the first prompt.",
          fingerprint: fingerprintOf("human", "supervision", "supervision"),
        }),
      ],
    })
    expect(markdown).toContain("# Learnings — samskara")
    expect(markdown).toContain("Generated 2026-08-25 from captured sessions")
    expect(markdown.indexOf("Bash failed 3 times in a row")).toBeLessThan(
      markdown.indexOf("2 prompts arrived while errors were piling up"),
    )
    expect(markdown).toContain("## For agents")
    expect(markdown).toContain("## For humans")
  })

  test("E2: an empty learning list renders an explicit empty note, not a bare heading", () => {
    const markdown = renderLearningsMarkdown({
      projectName: "samskara",
      generatedAt: new Date("2026-08-25T12:00:00Z"),
      learnings: [],
    })
    expect(markdown).toContain("No learnings yet")
  })
})

describe("renderKnowledgeLesson", () => {
  test("E3: renders frontmatter matching the .harness/knowledge lesson format", () => {
    const lesson = renderKnowledgeLesson(learning(), {
      projectId: "p1",
      sourceRef: "samskara-review://s1",
      date: new Date("2026-08-25T12:00:00Z"),
      occurrenceCount: 2,
    })
    expect(lesson.content).toContain('title: "Bash failed 3 times in a row"')
    expect(lesson.content).toContain("date: 2026-08-25")
    expect(lesson.content).toContain("category: tool-retry")
    expect(lesson.content).toContain("audience: agent")
    expect(lesson.content).toContain("status: candidate")
    expect(lesson.content).toContain("evidence_count: 1")
    expect(lesson.content).toContain("occurrence_count: 2")
    expect(lesson.content).toContain("source: samskara-review://s1")
    expect(lesson.content).toContain("## Problem")
    expect(lesson.content).toContain("## Prevention")
  })

  test("E4: slug is kebab-case, dated, and stable", () => {
    expect(lessonSlug("Bash failed 3 times in a row", "2026-08-25")).toBe(
      "bash-failed-3-times-in-a-row-20260825",
    )
  })
})

describe("knowledgeIndexFromLessons", () => {
  test("E5: index lines derive from lesson frontmatter, newest date first", () => {
    const lessons: KnowledgeLesson[] = [
      {
        title: "B lesson",
        path: "lessons/gotchas/b-lesson-20260801.md",
        category: "gotchas",
        appliesTo: ["packages/cli"],
        tags: ["vitest"],
        evidenceCount: 2,
        date: "2026-08-01",
        audience: "agent",
      },
      {
        title: "A lesson",
        path: "lessons/gotchas/a-lesson-20260802.md",
        category: "gotchas",
        appliesTo: [],
        tags: ["regex"],
        evidenceCount: 1,
        date: "2026-08-02",
        audience: "human",
      },
    ]
    const index = knowledgeIndexFromLessons(lessons)
    expect(index).toContain("# Knowledge Index")
    expect(index).toContain("Derived from frontmatter — do not edit.")
    expect(index.indexOf("A lesson")).toBeLessThan(index.indexOf("B lesson"))
    expect(index).toContain("applies_to: packages/cli")
    expect(index).toContain("ec:2")
    expect(index).toContain("· 2026-08-02")
  })
})
