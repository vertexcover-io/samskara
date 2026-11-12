/** The impact values as a reader sees them. */
export const IMPACT_LABEL: Readonly<Record<string, string>> = {
  wrong_result: "Wrong result",
  person_stepped_in: "Person had to step in",
  time_only: "Time only",
}

/** A sentence the writer started in lowercase, read after a label that ends with a full stop. */
export const asSentence = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)

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

/** The fix types the Type filter offers, in this order; the server accepts exactly these. */
export const FIX_TYPE_ORDER = [
  "skill",
  "code",
  "project_guidelines",
  "knowledge_base",
  "human",
] as const
export type FixTypeChoice = (typeof FIX_TYPE_ORDER)[number]

export const plural = (count: number, word: string): string =>
  `${count} ${word}${count === 1 ? "" : "s"}`
