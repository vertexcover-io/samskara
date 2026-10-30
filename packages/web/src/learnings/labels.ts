/** The impact values as a reader sees them. */
export const IMPACT_LABEL: Readonly<Record<string, string>> = {
  wrong_result: "Wrong result",
  person_stepped_in: "Person had to step in",
  time_only: "Time only",
}

export const PRIORITY_TONE: Readonly<Record<string, string>> = {
  high: "border-err/40 text-err",
  medium: "border-stamp/40 text-stamp",
  low: "border-rule text-ink-soft",
}

export const FIX_TYPE_LABEL: Readonly<Record<string, string>> = {
  skill: "Skill",
  code: "Code",
  project_guidelines: "Project guidelines",
  knowledge_base: "Knowledge base",
  human: "The person",
}

export const plural = (count: number, word: string): string =>
  `${count} ${word}${count === 1 ? "" : "s"}`
