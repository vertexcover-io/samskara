import {
  AGENT_LEARNING_CATEGORIES,
  type AgentLearningCategory,
  type AiReviewPayload,
  type AiReviewPayloadInput,
  aiReviewPayloadSchema,
  BREADCRUMB_CATEGORIES,
  type BreadcrumbLearningCategory,
  HUMAN_LEARNING_CATEGORIES,
  type HumanLearningCategory,
  LEARNING_SEVERITIES,
  NOTHING_TO_CHANGE_PREFIX,
  type ReviewCounts,
  type ReviewLearningAudience,
  TIMELINE_ENTRY_KINDS,
  type TimelineEntryKind,
} from "./schema.js"

export const REVIEW_XML_ROOT = "review"

/**
 * The model-facing XML vocabulary (template contract v2), one tag per line:
 *
 * - `review` — root. Attributes: `outcome`, `friction`, `model`, `harness` (model/harness may
 *   be `"?"`; the caller overwrites them with the runner's real values).
 * - `summary` — leaf text: the review summary (max 600). Also the per-entry summary leaf.
 * - `timeline` — the timeline section; contains `entry` elements.
 * - `entry` — one timeline entry. Attributes: `id`, `kind`, `from-seq`, `to-seq`, `tracks`
 *   (comma-separated), `tags` (comma-separated), and optionally `message-ids`
 *   (comma-separated) instead of the child container. Children: `title`, `summary`,
 *   `message-ids`. Kebab-case attributes have camelCase aliases (`fromSeq`, …).
 * - `title` — leaf text: entry or learning title (max 120).
 * - `message-ids` — container of `id` elements.
 * - `id` — leaf text: one message id from session.json.
 * - `humanLearnings` / `agentLearnings` / `breadcrumbs` — the learnings sections, one per
 *   audience; each contains `learning` elements whose `audience` must match the section.
 * - `learning` — one learning. Attributes: `category`, `audience`, `severity`
 *   (low|medium|high), optional `cost`. Children: `title`, `detail`, `nextTime`, `evidence`.
 * - `detail` — leaf text: the learning's detail (max 600).
 * - `nextTime` — leaf text: one imperative sentence — what to do differently next time
 *   (max 300). May be empty only on a "Nothing to change" entry.
 * - `evidence` — container of `ref` elements.
 * - `ref` — one evidence citation. Attributes: `seq`, `message-id` (alias `messageId`).
 *   Child: `what`.
 * - `what` — leaf text: what happened at the cited message (max 200).
 * - `counts` — self-reported entry counts. Attributes: `timeline`, `human`, `agent`,
 *   `breadcrumbs`. Filled programmatically by the reviewer; mismatches surface as `partial`.
 * - `lenses` — legacy v1 wrapper around the sections; hoisted, never written by the template.
 */
export const REVIEW_XML_TAGS = [
  "review",
  "summary",
  "timeline",
  "entry",
  "title",
  "message-ids",
  "id",
  "humanLearnings",
  "agentLearnings",
  "breadcrumbs",
  "learning",
  "detail",
  "nextTime",
  "evidence",
  "ref",
  "what",
  "counts",
  "lenses",
] as const

export type ReviewXmlTag = (typeof REVIEW_XML_TAGS)[number]

/**
 * Parse result: either a schema-valid payload (already run through `aiReviewPayloadSchema`,
 * so tracks defaults are applied and `partial` is attached on a counts mismatch), or a named
 * error. `recovered` names every malformation that was healed OR dropped, in the order the
 * passes ran — empty means the input was canonical. `selfCounts` carries the reviewer's own
 * `<counts>` when they parsed. `healed` is the v1 alias of `recovered`, kept until the
 * server pipeline migrates.
 */
export type ReviewXmlResult =
  | {
      readonly ok: true
      readonly value: AiReviewPayload
      readonly recovered: ReadonlyArray<string>
      readonly selfCounts?: ReviewCounts
      /** @deprecated v1 alias of `recovered`; remove once the server pipeline reads `recovered`. */
      readonly healed: ReadonlyArray<string>
    }
  | {
      readonly ok: false
      readonly error: string
      readonly recovered: ReadonlyArray<string>
      readonly selfCounts?: ReviewCounts
      /** @deprecated v1 alias of `recovered`; remove once the server pipeline reads `recovered`. */
      readonly healed: ReadonlyArray<string>
    }

const KNOWN_TAGS = new Set<string>(REVIEW_XML_TAGS)
const TEXT_MAXES = {
  title: 120,
  summary: 600,
  detail: 600,
  what: 200,
  nextTime: 300,
  cost: 120,
} as const
type TextTag = keyof typeof TEXT_MAXES

const START_RE = /<review(?=[\s/>])/
const ROOT_CLOSE = `</${REVIEW_XML_ROOT}>`
const FENCE_RE = /```[^\n`]*\n?([\s\S]*?)```/g

/** The four sections the template mandates, in template order. */
const SECTION_TAGS = ["timeline", "humanLearnings", "agentLearnings", "breadcrumbs"] as const
type SectionTag = (typeof SECTION_TAGS)[number]

const SECTION_AUDIENCE: Readonly<Record<Exclude<SectionTag, "timeline">, ReviewLearningAudience>> =
  {
    humanLearnings: "human",
    agentLearnings: "agent",
    breadcrumbs: "agent",
  }

type Token =
  | { kind: "text"; text: string }
  | { kind: "open"; name: string; attrs: Record<string, string>; selfClosing: boolean }
  | { kind: "close"; name: string }

type Element = {
  name: string
  attrs: Readonly<Record<string, string>>
  children: Element[]
  text: string
}

// --- the template (contract v2): pre-written review.xml the pipeline drops in the workspace ---

const EXAMPLE_NOTE = "repeat this block per entry, then delete the example"

/**
 * The pre-written `review.xml` skeleton: XML declaration, root, one commented worked example
 * per section, and a `<counts>` element with placeholder zeros. Deterministic — the prompt
 * embeds this exact text, so prompt, template and parser cannot drift.
 */
export const reviewXmlTemplate = (): string =>
  `<?xml version="1.0" encoding="UTF-8"?>
<review outcome="shipped" friction="none" model="?" harness="?">
  <!-- The two verdict attributes take exact words only, no others:
       outcome:  shipped (the task's artifact landed) | productive (useful work, nothing delivered) | struggled (most of the session stuck) | aborted (ended before finishing)
       friction: none | moderate | high -->
  <summary>REPLACE: one honest paragraph, at most 600 chars, the verdict for the whole session.</summary>
  <timeline>
    <!-- ${EXAMPLE_NOTE}
    <entry id="explore-phase" kind="phase" from-seq="0" to-seq="3" tracks="main" tags="exploration">
      <title>Exploration</title>
      <summary>What happened across this stretch of work and why it mattered.</summary>
      <message-ids>
        <id>msg-0</id>
        <id>msg-2</id>
      </message-ids>
    </entry>
    -->
  </timeline>
  <humanLearnings>
    <!-- ${EXAMPLE_NOTE}
    <learning category="communication" audience="human" severity="medium" cost="95s of 278s">
      <title>Name the file to touch</title>
      <detail>What the human could have done differently, in one or two sentences.</detail>
      <nextTime>One imperative sentence: what the human should do differently next time.</nextTime>
      <evidence>
        <ref seq="7" message-id="msg-7">
          <what>what happened at that message</what>
        </ref>
      </evidence>
    </learning>
    -->
  </humanLearnings>
  <agentLearnings>
    <!-- ${EXAMPLE_NOTE}
    <learning category="approach" audience="agent" severity="low">
      <title>Read the test before editing source</title>
      <detail>What the agent should have done differently, in one or two sentences.</detail>
      <nextTime>One imperative sentence: what the agent should do differently next time.</nextTime>
      <evidence>
        <ref seq="12" message-id="msg-12">
          <what>what happened at that message</what>
        </ref>
      </evidence>
    </learning>
    -->
  </agentLearnings>
  <breadcrumbs>
    <!-- ${EXAMPLE_NOTE}
    <learning category="query" audience="agent" severity="low">
      <title>Failed-jobs lookup</title>
      <detail>The psql query that lists failed jobs with their last error, so nobody re-derives it.</detail>
      <nextTime>Reach for this before writing a new query against the jobs table.</nextTime>
      <evidence>
        <ref seq="14" message-id="msg-14">
          <what>the query was worked out here</what>
        </ref>
      </evidence>
    </learning>
    -->
  </breadcrumbs>
  <!-- fill these numbers by counting the entries you wrote above, never by hand -->
  <counts timeline="0" human="0" agent="0" breadcrumbs="0"/>
</review>
`

// --- pass a: salvage the XML out of prose wrappers and code fences ------------------------

/** True when the text before the root is only whitespace, XML declarations and comments. */
const isCanonicalLeading = (leading: string): boolean =>
  leading
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim() === ""

const isCanonicalTrailing = (trailing: string): boolean =>
  trailing.replace(/<!--[\s\S]*?-->/g, "").trim() === ""

const salvageXml = (text: string): { xml: string; changed: boolean } | null => {
  let candidate = text
  let changed = false
  const fenced = [...text.matchAll(FENCE_RE)].filter((match) => START_RE.test(match[1] ?? ""))
  const last = fenced.at(-1)?.[1]
  if (last !== undefined && last.trim() !== text.trim()) {
    candidate = last
    changed = true
  }
  const start = candidate.search(START_RE)
  if (start < 0) return null
  const end = candidate.lastIndexOf(ROOT_CLOSE)
  const xml = end >= 0 ? candidate.slice(start, end + ROOT_CLOSE.length) : candidate.slice(start)
  const leading = candidate.slice(0, start)
  const trailing = end >= 0 ? candidate.slice(end + ROOT_CLOSE.length) : ""
  if (!isCanonicalLeading(leading) || !isCanonicalTrailing(trailing) || end < 0) changed = true
  return { xml, changed }
}

// --- pass b: escape bare markup characters ------------------------------------------------

const escapeBareMarkup = (xml: string, healed: string[]): string => {
  let escapedAmp = false
  let escapedLt = false
  const out = xml
    .replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, () => {
      escapedAmp = true
      return "&amp;"
    })
    .replace(/<(?![/a-zA-Z!?])/g, () => {
      escapedLt = true
      return "&lt;"
    })
  if (escapedAmp) healed.push("escaped bare &")
  if (escapedLt) healed.push("escaped bare <")
  return out
}

// --- tokenizer -----------------------------------------------------------------------------

const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9_-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/y
const ATTR_RE = /([a-zA-Z_][a-zA-Z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g

const decodeEntities = (text: string): string =>
  text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (match, entity: string) => {
    switch (entity) {
      case "amp":
        return "&"
      case "lt":
        return "<"
      case "gt":
        return ">"
      case "quot":
        return '"'
      case "apos":
        return "'"
      default: {
        const code = entity.startsWith("#x")
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10)
        return Number.isNaN(code) ? match : String.fromCodePoint(code)
      }
    }
  })

const parseAttrs = (blob: string): Record<string, string> => {
  const attrs: Record<string, string> = {}
  for (const match of blob.matchAll(ATTR_RE)) {
    const key = (match[1] ?? "").replaceAll("-", "").replaceAll("_", "").toLowerCase()
    attrs[key] = decodeEntities(match[2] ?? match[3] ?? "")
  }
  return attrs
}

const tokenize = (xml: string): Token[] => {
  const tokens: Token[] = []
  let index = 0
  while (index < xml.length) {
    const lt = xml.indexOf("<", index)
    if (lt === -1) {
      tokens.push({ kind: "text", text: xml.slice(index) })
      break
    }
    // Comments are consumed AT the "<" that opens them — checking at `index` (which sits on
    // the whitespace after the previous token) let commented-out examples tokenize as real
    // entries whenever a comment was preceded by anything but the previous tag's ">".
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4)
      index = end === -1 ? xml.length : end + 3
      continue
    }
    if (lt > index) tokens.push({ kind: "text", text: xml.slice(index, lt) })
    TAG_RE.lastIndex = lt
    const match = TAG_RE.exec(xml)
    if (match === null) {
      tokens.push({ kind: "text", text: "<" })
      index = lt + 1
      continue
    }
    const [, slash = "", name = "", blob = "", selfClose = ""] = match
    if (slash === "/") {
      tokens.push({ kind: "close", name })
    } else {
      tokens.push({ kind: "open", name, attrs: parseAttrs(blob), selfClosing: selfClose === "/" })
    }
    index = TAG_RE.lastIndex
  }
  return tokens
}

// --- pass c: balance the known vocabulary with a tag stack ---------------------------------

/** Section wrappers whose dropped opener can be recovered from a surviving close tag. */
const LENS_WRAPPER_TAGS = new Set<string>(["humanLearnings", "agentLearnings", "breadcrumbs"])
/** Vocabulary that can appear inside a <learning> — the trailing run an opener is reinserted around. */
const LEARNING_RUN_TAGS = new Set([
  "learning",
  "title",
  "detail",
  "nextTime",
  "evidence",
  "ref",
  "what",
])

/**
 * Index in `tokens` where a trailing run of learning vocabulary starts (everything after the
 * last structural token). A missing wrapper opener is reinserted exactly there — around its
 * children and nothing else.
 */
const trailingLearningRunStart = (tokens: ReadonlyArray<Token>): number => {
  let index = tokens.length
  while (index > 0) {
    const token = tokens[index - 1]
    if (token === undefined) break
    if (token.kind === "text") {
      index -= 1
      continue
    }
    if ((token.kind === "open" || token.kind === "close") && LEARNING_RUN_TAGS.has(token.name)) {
      index -= 1
      continue
    }
    break
  }
  return index
}

const balance = (tokens: ReadonlyArray<Token>, healed: string[]): Token[] => {
  const out: Token[] = []
  const stack: string[] = []
  const closeOf = (name: string) => {
    healed.push(`closed unclosed <${name}>`)
    return { kind: "close", name } as const
  }
  for (const token of tokens) {
    if (token.kind === "open" && !token.selfClosing) {
      if (KNOWN_TAGS.has(token.name)) stack.push(token.name)
      out.push(token)
      continue
    }
    if (token.kind !== "close") {
      out.push(token)
      continue
    }
    if (!KNOWN_TAGS.has(token.name)) {
      out.push(token)
      continue
    }
    const depth = stack.lastIndexOf(token.name)
    if (depth === -1) {
      // A learnings section that was never opened but whose close tag (and therefore
      // audience) survived: reinsert the opener around its trailing children. Only when
      // children exist — an empty run carries no evidence of which lens it was, so it
      // stays dropped and the section is reported missing rather than guessed into being.
      if (LENS_WRAPPER_TAGS.has(token.name)) {
        const insertAt = trailingLearningRunStart(out)
        const run = out.slice(insertAt)
        const hasChildren = run.some(
          (candidate) => candidate.kind === "open" && candidate.name === "learning",
        )
        if (hasChildren) {
          out.splice(insertAt, 0, { kind: "open", name: token.name, attrs: {}, selfClosing: false })
          healed.push(`inserted missing <${token.name}> opener`)
          out.push(token)
          continue
        }
      }
      healed.push(`dropped stray </${token.name}>`)
      continue
    }
    while (stack.length > depth + 1) out.push(closeOf(stack.pop() as string))
    stack.pop()
    out.push(token)
  }
  while (stack.length > 0) out.push(closeOf(stack.pop() as string))
  return out
}

// --- tree builder: drops unknown elements whole --------------------------------------------

const buildTree = (tokens: ReadonlyArray<Token>, healed: string[]): Element | null => {
  let i = 0

  const consumeUnknown = (name: string, ancestors: ReadonlySet<string>): void => {
    while (i < tokens.length) {
      const token = tokens[i]
      if (token === undefined) break
      if (token.kind === "close") {
        if (token.name === name) {
          i++
          return
        }
        if (ancestors.has(token.name)) return
      }
      i++
    }
  }

  const parseContent = (el: Element, ancestors: ReadonlySet<string>): void => {
    let text = ""
    while (i < tokens.length) {
      const token = tokens[i]
      if (token === undefined) break
      if (token.kind === "text") {
        text += token.text
        i++
        continue
      }
      if (token.kind === "close") {
        if (token.name === el.name) {
          i++
          break
        }
        if (ancestors.has(token.name)) break
        i++
        continue
      }
      if (token.selfClosing) {
        el.children.push({ name: token.name, attrs: token.attrs, children: [], text: "" })
        i++
        continue
      }
      if (!KNOWN_TAGS.has(token.name)) {
        i++
        consumeUnknown(token.name, ancestors)
        healed.push(`dropped unknown element <${token.name}>`)
        continue
      }
      const child: Element = { name: token.name, attrs: token.attrs, children: [], text: "" }
      i++
      parseContent(child, new Set([...ancestors, el.name]))
      el.children.push(child)
    }
    el.text = text
  }

  while (i < tokens.length) {
    const token = tokens[i]
    if (token === undefined) break
    if (token.kind !== "open" || token.name !== REVIEW_XML_ROOT) {
      i++
      continue
    }
    const root: Element = { name: token.name, attrs: token.attrs, children: [], text: "" }
    i++
    if (!token.selfClosing) parseContent(root, new Set())
    return root
  }
  return null
}

// --- per-element salvage and text normalization ---------------------------------------------

const isKind = (value: string): value is TimelineEntryKind =>
  (TIMELINE_ENTRY_KINDS as readonly string[]).includes(value)

const isHumanCategory = (value: string): value is HumanLearningCategory =>
  (HUMAN_LEARNING_CATEGORIES as readonly string[]).includes(value)

const isAgentCategory = (value: string): value is AgentLearningCategory =>
  (AGENT_LEARNING_CATEGORIES as readonly string[]).includes(value)

const isBreadcrumbCategory = (value: string): value is BreadcrumbLearningCategory =>
  (BREADCRUMB_CATEGORIES as readonly string[]).includes(value)

const isSeverity = (value: string): value is (typeof LEARNING_SEVERITIES)[number] =>
  (LEARNING_SEVERITIES as readonly string[]).includes(value)

const collapse = (raw: string): string => decodeEntities(raw).trim().replace(/\s+/g, " ")

const normalizeText = (raw: string, tag: TextTag, healed: string[]): string => {
  const decoded = decodeEntities(raw)
  const value = decoded.trim().replace(/\s+/g, " ")
  if (value !== decoded) healed.push(`normalized whitespace in <${tag}>`)
  const max = TEXT_MAXES[tag]
  if (value.length > max) {
    healed.push(`truncated ${tag}`)
    return value.slice(0, max)
  }
  return value
}

const childText = (el: Element, tag: string): string => {
  const child = el.children.find((candidate) => candidate.name === tag)
  return child === undefined ? "" : child.text
}

const intAttr = (el: Element, key: string): number | undefined => {
  const raw = el.attrs[key]
  return raw !== undefined && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : undefined
}

const listAttr = (el: Element, key: string): string[] | undefined => {
  const raw = el.attrs[key]
  if (raw === undefined) return undefined
  const parts = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "")
  return parts.length === 0 ? undefined : parts
}

const messageIdsOf = (entry: Element, healed: string[]): string[] => {
  const ids: string[] = []
  for (const child of entry.children) {
    if (child.name !== "message-ids") continue
    for (const id of child.children) {
      if (id.name !== "id") {
        healed.push(`dropped misplaced <${id.name}>`)
        continue
      }
      const value = collapse(id.text)
      if (value !== "") ids.push(value)
    }
  }
  if (ids.length === 0) {
    for (const part of (entry.attrs.messageids ?? "").split(",")) {
      const value = part.trim()
      if (value !== "") ids.push(value)
    }
  }
  return ids
}

type TimelineEntryInput = Extract<
  Extract<AiReviewPayloadInput["lenses"][number], { lens: "timeline" }>["entries"][number],
  unknown
>

const entryFrom = (entry: Element, healed: string[]): TimelineEntryInput | null => {
  const id = (entry.attrs.id ?? "").trim()
  const kind = (entry.attrs.kind ?? "").trim()
  const title = normalizeText(childText(entry, "title"), "title", healed)
  const summary = normalizeText(childText(entry, "summary"), "summary", healed)
  const fromSeq = intAttr(entry, "fromseq")
  const toSeq = intAttr(entry, "toseq")
  const messageIds = messageIdsOf(entry, healed)
  if (
    id === "" ||
    !isKind(kind) ||
    title === "" ||
    summary === "" ||
    fromSeq === undefined ||
    toSeq === undefined ||
    toSeq < fromSeq ||
    messageIds.length === 0
  ) {
    healed.push(`dropped <entry id="${id}">`)
    return null
  }
  const tracks = listAttr(entry, "tracks")
  const tags = listAttr(entry, "tags")
  return {
    id,
    kind,
    title,
    summary,
    fromSeq,
    toSeq,
    messageIds,
    ...(tracks === undefined ? {} : { tracks }),
    ...(tags === undefined ? {} : { tags }),
  }
}

type LearningInput = Extract<
  Extract<AiReviewPayloadInput["lenses"][number], { learnings: unknown }>["learnings"][number],
  unknown
>

const refFrom = (ref: Element, healed: string[]): LearningInput["evidence"][number] | null => {
  const seq = intAttr(ref, "seq")
  const messageId = (ref.attrs.messageid ?? "").trim()
  const what = normalizeText(childText(ref, "what"), "what", healed)
  if (seq === undefined || messageId === "" || what === "") {
    healed.push("dropped <ref>")
    return null
  }
  return { seq, messageId, what }
}

/**
 * Audience healing: the section is the structural truth. A missing audience is defaulted to
 * the section's; a contradicting one is corrected to it — both recorded, content never lost.
 */
const audienceOf = (
  learning: Element,
  section: Exclude<SectionTag, "timeline">,
  healed: string[],
): ReviewLearningAudience => {
  const claimed = (learning.attrs.audience ?? "").trim()
  const truth = SECTION_AUDIENCE[section]
  if (claimed === "") {
    healed.push("defaulted audience on <learning>")
    return truth
  }
  if (claimed !== truth) {
    healed.push(`corrected audience on <learning> to match <${section}>`)
    return truth
  }
  return truth
}

const severityOf = (learning: Element, healed: string[]): (typeof LEARNING_SEVERITIES)[number] => {
  const claimed = (learning.attrs.severity ?? "").trim()
  if (!isSeverity(claimed)) {
    healed.push("defaulted severity on <learning>")
    return "low"
  }
  return claimed
}

const learningFrom = (
  learning: Element,
  section: Exclude<SectionTag, "timeline">,
  healed: string[],
): LearningInput | null => {
  const audience = audienceOf(learning, section, healed)
  const severity = severityOf(learning, healed)
  const isValidCategory =
    section === "humanLearnings"
      ? isHumanCategory
      : section === "agentLearnings"
        ? isAgentCategory
        : isBreadcrumbCategory
  const category = (learning.attrs.category ?? "").trim()
  const title = normalizeText(childText(learning, "title"), "title", healed)
  const detail = normalizeText(childText(learning, "detail"), "detail", healed)
  const nextTime = normalizeText(childText(learning, "nextTime"), "nextTime", healed)
  const cost =
    learning.attrs.cost === undefined
      ? undefined
      : normalizeText(learning.attrs.cost, "cost", healed)
  const nothing = title.startsWith(NOTHING_TO_CHANGE_PREFIX)
  // An unknown or missing category defaults instead of costing the entry — severity and
  // audience already heal this way, and a real observation should not die over its label.
  const DEFAULT_CATEGORY: Readonly<Record<Exclude<SectionTag, "timeline">, string>> = {
    humanLearnings: "context",
    agentLearnings: "approach",
    breadcrumbs: "tool",
  }
  let effectiveCategory = category
  if (!isValidCategory(effectiveCategory)) {
    effectiveCategory = DEFAULT_CATEGORY[section] as LearningInput["category"]
    healed.push(`defaulted category on <learning> to "${effectiveCategory}"`)
  }
  const evidence: LearningInput["evidence"] = []
  for (const child of learning.children) {
    if (child.name !== "evidence") continue
    for (const ref of child.children) {
      if (ref.name !== "ref") {
        healed.push(`dropped misplaced <${ref.name}>`)
        continue
      }
      const built = refFrom(ref, healed)
      if (built !== null) evidence.push(built)
    }
  }
  // A nothing-entry exists to say "this audience came up empty" — an empty body must not
  // cost it. The title carries the meaning, so it stands in for the detail.
  const effectiveDetail = detail === "" && nothing ? title : detail
  if (effectiveDetail === "") {
    healed.push(`dropped <learning title="${title}"> (empty)`)
    return null
  }
  if (!nothing && nextTime === "") {
    healed.push(`dropped <learning title="${title}"> (no next time)`)
    return null
  }
  if (!nothing && evidence.length === 0) {
    healed.push(`dropped <learning title="${title}"> (no evidence ref)`)
    return null
  }
  return {
    title,
    detail: effectiveDetail,
    category: effectiveCategory,
    audience,
    severity,
    ...(nextTime === "" && !nothing ? {} : { nextTime }),
    ...(cost === "" ? {} : { cost }),
    evidence,
  } as LearningInput
}

// --- counts and section accounting ----------------------------------------------------------

const countsFrom = (el: Element): ReviewCounts | undefined => {
  const timeline = intAttr(el, "timeline")
  const human = intAttr(el, "human")
  const agent = intAttr(el, "agent")
  const breadcrumbs = intAttr(el, "breadcrumbs")
  if (
    timeline === undefined ||
    human === undefined ||
    agent === undefined ||
    breadcrumbs === undefined
  )
    return undefined
  return { timeline, human, agent, breadcrumbs }
}

const parsedCountsOf = (lenses: ReadonlyArray<AiReviewPayload["lenses"][number]>): ReviewCounts => {
  const counts: ReviewCounts = { timeline: 0, human: 0, agent: 0, breadcrumbs: 0 }
  for (const lens of lenses) {
    if (lens.lens === "timeline") counts.timeline += lens.entries.length
    else if (lens.lens === "humanLearnings") counts.human += lens.learnings.length
    else if (lens.lens === "agentLearnings") counts.agent += lens.learnings.length
    else counts.breadcrumbs += lens.learnings.length
  }
  return counts
}

const countsEqual = (a: ReviewCounts, b: ReviewCounts): boolean =>
  a.timeline === b.timeline &&
  a.human === b.human &&
  a.agent === b.agent &&
  a.breadcrumbs === b.breadcrumbs

// --- the parser: passes in order, then schema validation -----------------------------------

export const parseReviewXml = (text: string): ReviewXmlResult => {
  const healed: string[] = []

  const salvaged = salvageXml(text)
  if (salvaged === null) {
    return {
      ok: false,
      error: `no <${REVIEW_XML_ROOT}> element found in the output`,
      recovered: healed,
      healed,
    }
  }
  if (salvaged.changed) healed.push("stripped prose wrapper")

  const root = buildTree(balance(tokenize(escapeBareMarkup(salvaged.xml, healed)), healed), healed)
  if (root === null) {
    return {
      ok: false,
      error: `no <${REVIEW_XML_ROOT}> element found in the output`,
      recovered: healed,
      healed,
    }
  }

  let summary: string | undefined
  let selfCounts: ReviewCounts | undefined
  /** Sections found directly under root, plus any hoisted out of a legacy <lenses> wrapper. */
  const sections = new Map<SectionTag, Element>()
  const placeSection = (child: Element): void => {
    const tag = child.name as SectionTag
    if (sections.has(tag)) healed.push(`dropped misplaced <${tag}>`)
    else sections.set(tag, child)
  }

  for (const child of root.children) {
    if (child.name === "summary" && summary === undefined) {
      summary = normalizeText(child.text, "summary", healed)
    } else if (child.name === "lenses") {
      healed.push("hoisted sections from legacy <lenses> wrapper")
      for (const inner of child.children) {
        if ((SECTION_TAGS as readonly string[]).includes(inner.name)) placeSection(inner)
        else healed.push(`dropped misplaced <${inner.name}>`)
      }
    } else if (child.name === "counts" && selfCounts === undefined) {
      selfCounts = countsFrom(child)
      if (selfCounts === undefined) healed.push("malformed <counts>")
    } else if ((SECTION_TAGS as readonly string[]).includes(child.name)) {
      placeSection(child)
    } else {
      healed.push(`dropped misplaced <${child.name}>`)
    }
  }
  if (selfCounts === undefined && !root.children.some((child) => child.name === "counts")) {
    healed.push("missing <counts>")
  }

  // Section-level accounting: a section that never made it (or could not be recovered) is
  // NAMED and synthesized empty — silent loss is structurally impossible. A missing timeline
  // still fails validation below; missing learnings sections parse as empty and surface
  // through `recovered` plus the counts-mismatch `partial`.
  const lenses: AiReviewPayloadInput["lenses"] = []
  for (const tag of SECTION_TAGS) {
    const section = sections.get(tag)
    if (section === undefined) {
      healed.push(`dropped:${tag}`)
      if (tag === "timeline") lenses.push({ lens: "timeline", entries: [] })
      else lenses.push({ lens: tag, learnings: [] } as AiReviewPayloadInput["lenses"][number])
      continue
    }
    if (tag === "timeline") {
      const entries: TimelineEntryInput[] = []
      for (const entry of section.children) {
        if (entry.name !== "entry") {
          healed.push(`dropped misplaced <${entry.name}>`)
          continue
        }
        const built = entryFrom(entry, healed)
        if (built !== null) entries.push(built)
      }
      lenses.push({ lens: "timeline", entries })
    } else {
      const learnings: LearningInput[] = []
      for (const learning of section.children) {
        if (learning.name !== "learning") {
          healed.push(`dropped misplaced <${learning.name}>`)
          continue
        }
        const built = learningFrom(learning, tag, healed)
        if (built !== null) learnings.push(built)
      }
      lenses.push({ lens: tag, learnings } as AiReviewPayloadInput["lenses"][number])
    }
  }

  // A timeline with zero entries is worthless no matter why it is empty — name the reason
  // instead of letting the raw zod "Too small" message point at an array index.
  const timelineLens = lenses.find((lens) => lens.lens === "timeline")
  if (timelineLens === undefined || timelineLens.entries.length === 0) {
    const why = sections.has("timeline")
      ? "every timeline entry was malformed and dropped (or the section was left empty)"
      : "the timeline section is missing entirely"
    return {
      ok: false,
      error: `the timeline needs at least one entry — ${why}`,
      recovered: healed,
      ...(selfCounts === undefined ? {} : { selfCounts }),
      healed,
    }
  }

  const defaulted = (key: string): string => {
    const value = root.attrs[key]?.trim()
    if (value === undefined || value === "") {
      healed.push(`defaulted ${key}`)
      return "?"
    }
    return value
  }

  // Models write plausible synonyms for the coarse enums ("overcome" for friction,
  // "completed" for outcome). Synonyms normalize with a recorded healing line; a fully
  // unknown outcome is left for zod to reject visibly — the verdict must not be guessed.
  // "partial"/"mixed" map to shipped because something landed; the healing line and the
  // summary carry what did not.
  const OUTCOME_SYNONYMS: Record<string, AiReviewPayloadInput["outcome"]> = {
    complete: "shipped",
    completed: "shipped",
    delivered: "shipped",
    done: "shipped",
    partial: "shipped",
    mixed: "shipped",
  }
  const FRICTION_SYNONYMS: Record<string, AiReviewPayloadInput["friction"]> = {
    overcome: "moderate",
    low: "moderate",
    mild: "moderate",
    medium: "moderate",
    some: "moderate",
    minimal: "none",
    heavy: "high",
    severe: "high",
  }

  const normalizeEnum = (key: "outcome" | "friction", raw: string | undefined): string => {
    const value = raw?.trim().toLowerCase() ?? ""
    if (key === "friction") {
      // A canonical value passes through untouched — "none" is not a synonym to heal, it is
      // the answer (the template's own example carries it).
      if (value === "none" || value === "moderate" || value === "high") return value
      const mapped = FRICTION_SYNONYMS[value] ?? "moderate"
      if (value !== mapped) healed.push(`normalized friction "${raw?.trim() ?? ""}" → "${mapped}"`)
      return mapped
    }
    const mapped = OUTCOME_SYNONYMS[value]
    if (mapped !== undefined && mapped !== value) {
      healed.push(`normalized outcome "${raw?.trim() ?? ""}" → "${mapped}"`)
      return mapped
    }
    return value
  }

  const input: AiReviewPayloadInput = {
    analyzer: "ai-v1",
    model: defaulted("model"),
    harness: defaulted("harness"),
    // Enum-shaped strings: zod below is the authority that they are real enum values,
    // after synonym normalization — a model writing friction="overcome" must not cost
    // the whole review.
    outcome: normalizeEnum("outcome", root.attrs.outcome) as AiReviewPayloadInput["outcome"],
    friction: normalizeEnum("friction", root.attrs.friction) as AiReviewPayloadInput["friction"],
    summary: summary ?? "",
    lenses,
  }

  const validated = aiReviewPayloadSchema.safeParse(input)
  if (!validated.success) {
    const issues = validated.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ")
    return {
      ok: false,
      error: `schema validation failed: ${issues}`,
      recovered: healed,
      ...(selfCounts === undefined ? {} : { selfCounts }),
      healed,
    }
  }

  // Counts accounting: attach `partial` when the reviewer's own numbers disagree with what
  // actually survived — the loud replacement for the silent half-deliverable incident.
  const parsed = parsedCountsOf(validated.data.lenses)
  const partial =
    selfCounts !== undefined && !countsEqual(selfCounts, parsed)
      ? { claimed: selfCounts, parsed }
      : undefined

  return {
    ok: true,
    value: partial === undefined ? validated.data : { ...validated.data, partial },
    recovered: healed,
    ...(selfCounts === undefined ? {} : { selfCounts }),
    healed,
  }
}
