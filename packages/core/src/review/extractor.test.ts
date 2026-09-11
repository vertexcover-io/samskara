import { describe, expect, test } from "vitest"
import { heuristicSessionAnalyzer } from "./analyzer.js"
import type { ReviewEventBody } from "./events.js"
import { extractLearnings } from "./extractor.js"
import type { SessionReview } from "./types.js"

const prompt = (text: string): ReviewEventBody => ({ kind: "userMessage", text, isMeta: false })
const call = (name: string, id: string): ReviewEventBody => ({
  kind: "toolCall",
  callId: id,
  name,
})
const result = (id: string, status: "success" | "failure" = "success"): ReviewEventBody => ({
  kind: "toolResult",
  callId: id,
  name: null,
  status,
})

const reviewWith = (
  ...bodies: ReviewEventBody[]
): { review: SessionReview; events: ReturnType<typeof sequenced> } => {
  const events = sequenced(bodies)
  return { review: heuristicSessionAnalyzer.analyze({ sessionId: "s-extract", events }), events }
}

const sequenced = (bodies: ReadonlyArray<ReviewEventBody>) =>
  bodies.map((body, index) => ({ ...body, seq: index }))

const allLearnings = (review: SessionReview, events: ReadonlyArray<{ seq: number }>) => {
  const { agent, human } = extractLearnings(
    review.signals,
    events as Parameters<typeof extractLearnings>[1],
  )
  return [...agent, ...human]
}

describe("extractLearnings", () => {
  test("X1: an error loop yields an agent learning naming the tool and count", () => {
    const { review, events } = reviewWith(
      prompt("go"),
      call("Bash", "a"),
      result("a", "failure"),
      call("Bash", "b"),
      result("b", "failure"),
      call("Bash", "c"),
      result("c", "failure"),
    )
    const learnings = allLearnings(review, events)
    const loop = learnings.find((l) => l.category === "tool-retry")
    expect(loop).toBeDefined()
    expect(loop?.audience).toBe("agent")
    expect(loop?.title).toContain("Bash")
    expect(loop?.title).toContain("3")
    expect(loop?.evidence.length).toBeGreaterThan(0)
    expect(loop?.evidence[0]?.seq).toBeGreaterThanOrEqual(0)
  })

  test("X2: prompts after failures yield human supervision feedback", () => {
    const { review, events } = reviewWith(
      prompt("go"),
      call("Bash", "a"),
      result("a", "failure"),
      call("Bash", "b"),
      result("b", "failure"),
      prompt("stop doing that"),
      call("Bash", "c"),
      result("c", "failure"),
      call("Bash", "d"),
      result("d", "failure"),
      prompt("again no"),
    )
    const feedback = allLearnings(review, events).filter((l) => l.audience === "human")
    expect(feedback.some((l) => l.category === "supervision")).toBe(true)
  })

  test("X3: rapid re-prompts yield prompt-shape feedback", () => {
    const { review, events } = reviewWith(prompt("one"), prompt("two"), prompt("three"))
    const feedback = allLearnings(review, events).filter((l) => l.category === "prompt-shape")
    expect(feedback).toHaveLength(1)
    expect(feedback[0]?.detail).toContain("2")
  })

  test("X4: compactions beyond one yield a context-hygiene learning", () => {
    const { review, events } = reviewWith(
      prompt("go"),
      { kind: "compaction" },
      { kind: "compaction" },
      { kind: "turn", status: "completed" },
    )
    const learnings = allLearnings(review, events)
    expect(learnings.some((l) => l.category === "context-hygiene")).toBe(true)
  })

  test("X5: aborted turns yield a task-shape learning for the human", () => {
    const { review, events } = reviewWith(
      prompt("go"),
      { kind: "turn", status: "aborted" },
      prompt("go 2"),
      { kind: "turn", status: "aborted" },
    )
    const learnings = allLearnings(review, events)
    const taskShape = learnings.find((l) => l.category === "task-shape")
    expect(taskShape?.audience).toBe("human")
  })

  test("X6: edit churn on one path yields an agent rework learning", () => {
    const { review, events } = reviewWith(
      prompt("go"),
      { kind: "edit", path: "src/one.ts" },
      { kind: "edit", path: "src/one.ts" },
      { kind: "edit", path: "src/one.ts" },
      { kind: "edit", path: "src/one.ts" },
      { kind: "turn", status: "completed" },
    )
    const learnings = allLearnings(review, events)
    const rework = learnings.find((l) => l.title.includes("src/one.ts"))
    expect(rework?.audience).toBe("agent")
    expect(rework?.detail).toContain("4")
  })

  test("X7: a clean session yields no learnings", () => {
    const { review, events } = reviewWith(
      prompt("go"),
      call("Grep", "a"),
      result("a"),
      { kind: "assistantMessage" },
      { kind: "turn", status: "completed" },
    )
    const { agent, human } = extractLearnings(review.signals, events)
    expect(agent).toEqual([])
    expect(human).toEqual([])
  })

  test("X8: fingerprints are stable for identical signal shapes and differ otherwise", () => {
    const mk = () =>
      reviewWith(
        prompt("go"),
        call("Bash", "a"),
        result("a", "failure"),
        call("Bash", "b"),
        result("b", "failure"),
        call("Bash", "c"),
        result("c", "failure"),
      )
    const first = extractLearnings(mk().review.signals, mk().events).agent.find(
      (l) => l.category === "tool-retry",
    )
    const second = extractLearnings(mk().review.signals, mk().events).agent.find(
      (l) => l.category === "tool-retry",
    )
    expect(first?.fingerprint).toBe(second?.fingerprint)

    const otherTool = reviewWith(
      prompt("go"),
      call("WebFetch", "a"),
      result("a", "failure"),
      call("WebFetch", "b"),
      result("b", "failure"),
      call("WebFetch", "c"),
      result("c", "failure"),
    )
    const different = extractLearnings(otherTool.review.signals, otherTool.events).agent.find(
      (l) => l.category === "tool-retry",
    )
    expect(different?.fingerprint).not.toBe(first?.fingerprint)
  })

  test("X9: every learning carries at least one evidence ref", () => {
    const { review, events } = reviewWith(
      prompt("go"),
      call("Bash", "a"),
      result("a", "failure"),
      call("Bash", "b"),
      result("b", "failure"),
      call("Bash", "c"),
      result("c", "failure"),
      prompt("nope"),
      prompt("really nope"),
      { kind: "turn", status: "aborted" },
      { kind: "turn", status: "aborted" },
    )
    const { agent, human } = extractLearnings(review.signals, events)
    for (const learning of [...agent, ...human]) {
      expect(learning.evidence.length).toBeGreaterThan(0)
    }
  })
})
