import type { LearningCandidate } from "./types.js"

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

const ymd = (date: Date): string => date.toISOString().slice(0, 10)

/**
 * LEARNINGS.md is generated, never hand-edited: `samskara learn --write` overwrites it whole.
 * The header says so, because a reader who cannot tell generated from authored will eventually
 * hand-merge and lose the regeneration.
 */
export const renderLearningsMarkdown = (input: {
  readonly projectName: string
  readonly generatedAt: Date
  readonly learnings: ReadonlyArray<LearningCandidate>
}): string => {
  const lines: string[] = [
    `# Learnings — ${input.projectName}`,
    "",
    `Generated ${ymd(input.generatedAt)} from captured sessions by \`samskara learn --write\`.`,
    "This file is regenerated whole — edit the accepted learnings on the server, not this file.",
    "",
  ]
  if (input.learnings.length === 0) {
    lines.push("No learnings yet. Review sessions with `samskara review` to start the loop.", "")
    return lines.join("\n")
  }
  const agents = input.learnings.filter((learning) => learning.audience === "agent")
  const humans = input.learnings.filter((learning) => learning.audience === "human")
  const section = (title: string, items: ReadonlyArray<LearningCandidate>) => {
    if (items.length === 0) return
    lines.push(`## ${title}`, "")
    for (const item of items) {
      lines.push(`- **${item.title}** \`${item.category}\``, `  ${item.detail}`)
    }
    lines.push("")
  }
  section("For agents", agents)
  section("For humans", humans)
  return lines.join("\n")
}

export const lessonSlug = (title: string, date: string): string =>
  `${title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")}-${date.replaceAll("-", "")}`

/**
 * One lesson file in the `.harness/knowledge/` house format: frontmatter the index derives
 * from, then Problem/Prevention/Evidence. `source` is a review URL so a reader can trace the
 * claim back to the session that produced it.
 */
export const renderKnowledgeLesson = (
  learning: LearningCandidate,
  meta: {
    readonly projectId: string
    /** Where a reader traces the claim: a review URL, a learning id — whatever the writer knows. */
    readonly sourceRef: string
    readonly date: Date
    readonly occurrenceCount: number
  },
): { readonly path: string; readonly content: string } => {
  const date = ymd(meta.date)
  // No applies_to yet: learnings are session-derived, not file-derived. The field stays in the
  // frontmatter (the index reads it) and fills when a curator names the files it applies to.
  const appliesTo: ReadonlyArray<string> = []
  const evidenceLines = learning.evidence.map((ref) => `- event ${ref.seq}: ${ref.what}`)
  const content = [
    "---",
    `title: "${learning.title.replaceAll('"', "'")}"`,
    `date: ${date}`,
    `category: ${learning.category}`,
    `audience: ${learning.audience}`,
    "status: candidate",
    `applies_to: [${appliesTo.join(", ")}]`,
    `evidence_count: ${learning.evidence.length}`,
    `occurrence_count: ${meta.occurrenceCount}`,
    `last_validated: ${date}`,
    `source: ${meta.sourceRef}`,
    "related: []",
    "---",
    "",
    `# ${learning.title}`,
    "",
    "## Problem",
    "",
    learning.detail,
    "",
    "## Prevention",
    "",
    learning.audience === "agent"
      ? "Apply this before the next retry of the same failing call shape."
      : "Apply this when writing the next prompt for this kind of task.",
    "",
    "## Evidence",
    "",
    ...evidenceLines,
    "",
    "## Related",
    "",
    "(none)",
    "",
  ].join("\n")
  return { path: `lessons/${learning.category}/${lessonSlug(learning.title, date)}.md`, content }
}

/** The index derives from lesson frontmatter only — same contract as the existing INDEX.md. */
export type KnowledgeLesson = {
  readonly title: string
  readonly path: string
  readonly category: string
  readonly appliesTo: ReadonlyArray<string>
  readonly tags: ReadonlyArray<string>
  readonly evidenceCount: number
  readonly date: string
  readonly audience: string
}

export const knowledgeIndexFromLessons = (lessons: ReadonlyArray<KnowledgeLesson>): string => {
  // Newest first, then title — a reader updating the index wants the recent lessons on top.
  const sorted = [...lessons].sort((a, b) =>
    a.date === b.date ? a.title.localeCompare(b.title) : b.date.localeCompare(a.date),
  )
  const lines = [
    "# Knowledge Index",
    "",
    "Derived from frontmatter — do not edit. Regenerate: `samskara learn --write`.",
    "",
  ]
  for (const lesson of sorted) {
    const applies =
      lesson.appliesTo.length > 0 ? ` · applies_to: ${lesson.appliesTo.join(", ")}` : ""
    const tags = lesson.tags.length > 0 ? ` · tags: ${lesson.tags.join(", ")}` : ""
    lines.push(
      `- [${lesson.title}](${lesson.path})${applies}${tags} · ec:${lesson.evidenceCount} · ${lesson.date}`,
    )
  }
  lines.push("")
  return lines.join("\n")
}

export const isDateOnly = (value: string): boolean => DATE_ONLY.test(value)
