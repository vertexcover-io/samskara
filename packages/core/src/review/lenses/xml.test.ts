import { describe, expect, test } from "vitest"
import { NOTHING_TO_CHANGE_PREFIX, type ReviewCounts } from "./schema.js"
import { parseReviewXml, REVIEW_XML_ROOT, REVIEW_XML_TAGS, reviewXmlTemplate } from "./xml.js"

/**
 * A canonical filled review.xml: exactly what the pipeline hopes to read back — template
 * structure, examples deleted, real entries in place, counts filled by counting.
 */
const filledXml = `<?xml version="1.0" encoding="UTF-8"?>
<review outcome="shipped" friction="moderate" model="?" harness="?">
  <summary>The session shipped a small fix after one mid-course correction.</summary>
  <timeline>
    <entry id="setup-explored" kind="phase" from-seq="0" to-seq="6" tracks="main">
      <title>Explored the repo</title>
      <summary>Read the failing test and its caller before editing.</summary>
      <message-ids>
        <id>msg-0</id>
        <id>msg-3</id>
      </message-ids>
    </entry>
  </timeline>
  <humanLearnings>
    <learning category="communication" audience="human" severity="medium" cost="95s of 278s">
      <title>Name the file to touch</title>
      <detail>The first prompt omitted the path, so the agent guessed wrong.</detail>
      <nextTime>Open the task by naming the exact file to change.</nextTime>
      <evidence>
        <ref seq="7" message-id="msg-7">
          <what>the agent edited the wrong file</what>
        </ref>
      </evidence>
    </learning>
  </humanLearnings>
  <agentLearnings>
    <learning category="approach" audience="agent" severity="low">
      <title>Read the test before editing source</title>
      <detail>The tests named the exact convention the edit broke.</detail>
      <nextTime>Read the covering test before editing the source it guards.</nextTime>
      <evidence>
        <ref seq="12" message-id="msg-12">
          <what>the failing test run pointed at the convention</what>
        </ref>
      </evidence>
    </learning>
  </agentLearnings>
  <breadcrumbs>
    <learning category="query" audience="agent" severity="low" cost="40s of 278s">
      <title>Failed-jobs lookup</title>
      <detail>The psql query lists failed jobs with their last error, so nobody re-derives it.</detail>
      <nextTime>Reach for this before writing a new query against the jobs table.</nextTime>
      <evidence>
        <ref seq="2" message-id="msg-2">
          <what>the query was worked out here</what>
        </ref>
      </evidence>
    </learning>
  </breadcrumbs>
  <counts timeline="1" human="1" agent="1" breadcrumbs="1"/>
</review>
`

const goldenLenses = [
  {
    lens: "timeline",
    entries: [
      {
        id: "setup-explored",
        kind: "phase",
        title: "Explored the repo",
        summary: "Read the failing test and its caller before editing.",
        fromSeq: 0,
        toSeq: 6,
        messageIds: ["msg-0", "msg-3"],
        tracks: ["main"],
      },
    ],
  },
  {
    lens: "humanLearnings",
    learnings: [
      {
        title: "Name the file to touch",
        detail: "The first prompt omitted the path, so the agent guessed wrong.",
        category: "communication",
        audience: "human",
        severity: "medium",
        cost: "95s of 278s",
        nextTime: "Open the task by naming the exact file to change.",
        evidence: [{ seq: 7, messageId: "msg-7", what: "the agent edited the wrong file" }],
      },
    ],
  },
  {
    lens: "agentLearnings",
    learnings: [
      {
        title: "Read the test before editing source",
        detail: "The tests named the exact convention the edit broke.",
        category: "approach",
        audience: "agent",
        severity: "low",
        nextTime: "Read the covering test before editing the source it guards.",
        evidence: [
          { seq: 12, messageId: "msg-12", what: "the failing test run pointed at the convention" },
        ],
      },
    ],
  },
  {
    lens: "breadcrumbs",
    learnings: [
      {
        title: "Failed-jobs lookup",
        detail: "The psql query lists failed jobs with their last error, so nobody re-derives it.",
        category: "query",
        audience: "agent",
        severity: "low",
        cost: "40s of 278s",
        nextTime: "Reach for this before writing a new query against the jobs table.",
        evidence: [{ seq: 2, messageId: "msg-2", what: "the query was worked out here" }],
      },
    ],
  },
]

const matchingCounts: ReviewCounts = { timeline: 1, human: 1, agent: 1, breadcrumbs: 1 }

describe("reviewXmlTemplate", () => {
  test("T1: renders a complete skeleton with declaration, four sections, commented examples and counts", () => {
    const template = reviewXmlTemplate()
    expect(template.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
    expect(template.trimEnd().endsWith("</review>")).toBe(true)
    expect(template).toContain("<review ")
    expect(template).toContain("<summary>")
    for (const section of [
      "<timeline>",
      "<humanLearnings>",
      "<agentLearnings>",
      "<breadcrumbs>",
      "<counts",
    ]) {
      expect(template).toContain(section)
    }
    // One worked example per section, inside XML comments, each with the repeat note.
    expect(template.match(/<!--/g)?.length).toBeGreaterThanOrEqual(5)
    for (const section of ["timeline", "humanLearnings", "agentLearnings", "breadcrumbs"]) {
      const wrapper = template.match(
        new RegExp(`<${section}>\\s*<!--[\\s\\S]*?-->\\s*</${section}>`),
      )
      expect(wrapper).not.toBeNull()
      expect(wrapper?.[0]).toContain("repeat this block per entry, then delete the example")
    }
    expect(template).toMatch(/<counts timeline="\d+" human="\d+" agent="\d+" breadcrumbs="\d+"\/>/)
  })

  test("T2: is deterministic", () => {
    expect(reviewXmlTemplate()).toBe(reviewXmlTemplate())
  })

  test("T3: the template's own examples use the full v2 learning vocabulary", () => {
    const template = reviewXmlTemplate()
    for (const audience of ['audience="human"', 'audience="agent"']) {
      expect(template).toContain(audience)
    }
    expect(template).toContain('category="query"')
    expect(template).toContain("Failed-jobs lookup")
    expect(template).toContain("severity=")
    expect(template).toContain("<nextTime>")
    expect(template).toContain("<ref ")
    expect(template).toContain("message-id=")
  })

  test("T4: comments never contain a double dash (they stay legal XML comments)", () => {
    for (const match of reviewXmlTemplate().matchAll(/<!--([\s\S]*?)-->/g)) {
      expect(match[1]).not.toContain("--")
    }
  })

  test("T5: the template states the verdict enums beside the root, so the file alone teaches the contract", () => {
    const template = reviewXmlTemplate()
    const rootComment = template.match(/<review [^>]*>\s*<!--([\s\S]*?)-->/)
    expect(rootComment).not.toBeNull()
    for (const word of ["shipped", "productive", "struggled", "aborted"]) {
      expect(rootComment?.[1]).toContain(word)
    }
    for (const word of ["none", "moderate", "high"]) {
      expect(rootComment?.[1]).toContain(word)
    }
  })
})

describe("parseReviewXml — file contract", () => {
  test("X1: a filled template file parses clean: payload, selfCounts, no partial, nothing recovered", () => {
    const result = parseReviewXml(filledXml)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual({
      analyzer: "ai-v1",
      model: "?",
      harness: "?",
      outcome: "shipped",
      friction: "moderate",
      summary: "The session shipped a small fix after one mid-course correction.",
      lenses: goldenLenses,
    })
    expect(result.selfCounts).toEqual(matchingCounts)
    expect(result.value.partial).toBeUndefined()
    expect(result.recovered).toEqual([])
  })

  test("X2: the raw template (nothing filled) fails loud on the empty timeline, not silently", () => {
    const result = parseReviewXml(reviewXmlTemplate())
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toMatch(/timeline/i)
      // Nothing was healed: the template is well-formed, just unfilled. The commented
      // examples must NOT parse as entries (the tokenizer skips comments at the "<").
      expect(result.recovered).toEqual([])
      expect(result.selfCounts).toEqual({ timeline: 0, human: 0, agent: 0, breadcrumbs: 0 })
    }
  })

  test("X3: an incremental-partial file (one section filled, examples still commented) parses with partial accounting", () => {
    // The model finished the timeline, learnings sections still hold only commented examples.
    const partial = filledXml.replace(
      / {2}<humanLearnings>[\s\S]*?<\/humanLearnings>\n {2}<agentLearnings>[\s\S]*?<\/agentLearnings>\n {2}<breadcrumbs>[\s\S]*?<\/breadcrumbs>\n/,
      "  <humanLearnings>\n  </humanLearnings>\n  <agentLearnings>\n  </agentLearnings>\n  <breadcrumbs>\n  </breadcrumbs>\n",
    )
    const result = parseReviewXml(partial)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const human = result.value.lenses.find((lens) => lens.lens === "humanLearnings")
    expect(human?.learnings).toEqual([])
    // Counts still claim the full intent: the mismatch surfaces as partial, never silently.
    expect(result.value.partial).toEqual({
      claimed: matchingCounts,
      parsed: { timeline: 1, human: 0, agent: 0, breadcrumbs: 0 },
    })
  })

  test("X4: a counts mismatch on a filled file surfaces as partial (the incident shape)", () => {
    // Reviewer claimed 20 timeline entries, 8 survived the file: claimed != parsed.
    const text = filledXml.replace(
      '<counts timeline="1" human="1" agent="1" breadcrumbs="1"/>',
      '<counts timeline="20" human="4" agent="5" breadcrumbs="2"/>',
    )
    const result = parseReviewXml(text)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.selfCounts).toEqual({ timeline: 20, human: 4, agent: 5, breadcrumbs: 2 })
    expect(result.value.partial).toEqual({
      claimed: { timeline: 20, human: 4, agent: 5, breadcrumbs: 2 },
      parsed: matchingCounts,
    })
  })

  test("X5: a whole missing section is named in recovered and synthesized empty, not silently omitted", () => {
    const text = filledXml.replace(/ {2}<humanLearnings>[\s\S]*?<\/humanLearnings>\n/, "")
    const result = parseReviewXml(text)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const human = result.value.lenses.find((lens) => lens.lens === "humanLearnings")
    expect(human?.learnings).toEqual([])
    expect(result.recovered).toContain("dropped:humanLearnings")
    expect(result.value.partial).toEqual({
      claimed: matchingCounts,
      parsed: { timeline: 1, human: 0, agent: 1, breadcrumbs: 1 },
    })
  })

  test("X6: a missing timeline section is a loud failure, not an empty success", () => {
    const text = filledXml.replace(/ {2}<timeline>[\s\S]*?<\/timeline>\n/, "")
    const result = parseReviewXml(text)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.recovered).toContain("dropped:timeline")
      expect(result.error).toMatch(/timeline/i)
    }
  })

  test("X7: a missing counts element is reported; no selfCounts, no partial", () => {
    const text = filledXml.replace(/ {2}<counts[^>]*\/>\n/, "")
    const result = parseReviewXml(text)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.recovered).toContain("missing <counts>")
    expect(result.selfCounts).toBeUndefined()
    expect(result.value.partial).toBeUndefined()
  })

  test("X8: a malformed counts element is reported and ignored", () => {
    const text = filledXml.replace(
      '<counts timeline="1" human="1" agent="1" breadcrumbs="1"/>',
      '<counts timeline="1" human="one" agent="1" breadcrumbs="1"/>',
    )
    const result = parseReviewXml(text)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.recovered).toContain("malformed <counts>")
    expect(result.selfCounts).toBeUndefined()
    expect(result.value.partial).toBeUndefined()
  })

  test("X9: the XML declaration and leading comments are not healed as prose wrappers", () => {
    const text = `<?xml version="1.0" encoding="UTF-8"?>\n<!-- a leading note -->\n${filledXml.slice(filledXml.indexOf("<review"))}`
    const result = parseReviewXml(text)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.recovered).toEqual([])
  })
})

describe("parseReviewXml — learning vocabulary", () => {
  test("X10: a missing audience attribute is defaulted to the section's audience and recorded", () => {
    const text = filledXml.replace(
      ' category="communication" audience="human"',
      ' category="communication"',
    )
    const result = parseReviewXml(text)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const human = result.value.lenses.find((lens) => lens.lens === "humanLearnings")
    expect(human?.learnings[0]?.audience).toBe("human")
    expect(result.recovered).toContain("defaulted audience on <learning>")
  })

  test("X11: an audience that contradicts its section is corrected to the section and recorded", () => {
    const text = filledXml.replace('audience="human"', 'audience="agent"')
    const result = parseReviewXml(text)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const human = result.value.lenses.find((lens) => lens.lens === "humanLearnings")
    expect(human?.learnings[0]?.audience).toBe("human")
    expect(result.recovered).toContain("corrected audience on <learning> to match <humanLearnings>")
  })

  test("X12: a missing or invalid severity is defaulted to low and recorded", () => {
    const text = filledXml.replace(
      'category="query" audience="agent" severity="low"',
      'category="query" audience="agent" severity="extreme"',
    )
    const result = parseReviewXml(text)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const breadcrumb = result.value.lenses.find((lens) => lens.lens === "breadcrumbs")
    expect(breadcrumb?.learnings[0]?.severity).toBe("low")
    expect(result.recovered).toContain("defaulted severity on <learning>")
  })

  test("X13: a learning missing nextTime is dropped by name (never silently)", () => {
    const text = filledXml.replace(
      "      <nextTime>Read the covering test before editing the source it guards.</nextTime>\n",
      "",
    )
    const result = parseReviewXml(text)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const agent = result.value.lenses.find((lens) => lens.lens === "agentLearnings")
    expect(agent?.learnings).toEqual([])
    expect(result.recovered).toContain(
      'dropped <learning title="Read the test before editing source"> (no next time)',
    )
    expect(result.value.partial).toEqual({
      claimed: matchingCounts,
      parsed: { timeline: 1, human: 1, agent: 0, breadcrumbs: 1 },
    })
  })

  test("X14: a nothing-entry may carry an empty nextTime and no evidence", () => {
    const nothing = `    <learning category="process" audience="agent" severity="low">
      <title>${NOTHING_TO_CHANGE_PREFIX} for the agent</title>
      <detail>The agent worked well; no change worth asking for.</detail>
      <nextTime></nextTime>
    </learning>
`
    const text = filledXml.replace(
      /(<agentLearnings>\n)[\s\S]*?(\n {2}<\/agentLearnings>)/,
      `$1${nothing.trimEnd()}$2`,
    )
    const result = parseReviewXml(text)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const agent = result.value.lenses.find((lens) => lens.lens === "agentLearnings")
    expect(agent?.learnings).toEqual([
      {
        title: `${NOTHING_TO_CHANGE_PREFIX} for the agent`,
        detail: "The agent worked well; no change worth asking for.",
        category: "process",
        audience: "agent",
        severity: "low",
        nextTime: "",
        evidence: [],
      },
    ])
  })

  test("X15: a wrong-category learning defaults its category and survives, with the healing recorded", () => {
    const text = filledXml.replace('category="query"', 'category="communication"')
    const result = parseReviewXml(text)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const breadcrumbs = result.value.lenses.find((lens) => lens.lens === "breadcrumbs")
    expect(breadcrumbs?.learnings).toHaveLength(1)
    expect(breadcrumbs?.learnings[0]).toMatchObject({
      title: "Failed-jobs lookup",
      category: "tool",
    })
    expect(result.recovered).toContain('defaulted category on <learning> to "tool"')
  })

  test("X16: a learning with refs that parse keeps them all; a broken ref drops by name", () => {
    const text = filledXml.replace(
      '        <ref seq="2" message-id="msg-2">\n          <what>the query was worked out here</what>\n        </ref>',
      '        <ref seq="2" message-id="msg-2">\n          <what>the query was worked out here</what>\n        </ref>\n        <ref seq="x" message-id="msg-2">\n          <what>bogus</what>\n        </ref>',
    )
    const result = parseReviewXml(text)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const breadcrumbs = result.value.lenses.find((lens) => lens.lens === "breadcrumbs")
    expect(breadcrumbs?.learnings[0]?.evidence).toHaveLength(1)
    expect(result.recovered).toContain("dropped <ref>")
  })
})

describe("parseReviewXml — healing carries forward", () => {
  test("X17: a fenced stdout block is still salvaged as fallback and recorded", () => {
    const text = [
      "I filled in review.xml as asked.",
      "",
      "```xml",
      filledXml,
      "```",
      "",
      "review.xml ready, 1 timeline entry",
    ].join("\n")
    const result = parseReviewXml(text)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.lenses).toEqual(goldenLenses)
      expect(result.selfCounts).toEqual(matchingCounts)
      expect(result.recovered).toContain("stripped prose wrapper")
    }
  })

  test("X18: bare & and bare < in detail text are escaped, decoded back, and recorded", () => {
    const text = filledXml.replace(
      "The first prompt omitted the path, so the agent guessed wrong.",
      "Flags a & b collided when the count dropped < 5.",
    )
    const result = parseReviewXml(text)
    expect(result.ok).toBe(true)
    if (result.ok) {
      const human = result.value.lenses.find((lens) => lens.lens === "humanLearnings")
      expect(human?.learnings[0]?.detail).toBe("Flags a & b collided when the count dropped < 5.")
      expect(result.recovered).toContain("escaped bare &")
      expect(result.recovered).toContain("escaped bare <")
    }
  })

  test("X19: an unclosed <entry> is closed at its parent and recorded", () => {
    const text = filledXml.replace("    </entry>\n", "")
    const result = parseReviewXml(text)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.lenses[0]).toEqual(goldenLenses[0])
      expect(result.recovered).toContain("closed unclosed <entry>")
    }
  })

  test("X20: a malformed entry is dropped by name while its sibling survives", () => {
    const broken = [
      '    <entry id="broken" kind="phase" from-seq="x" to-seq="9">',
      "      <title>Bad entry</title>",
      "      <summary>from-seq is not a number.</summary>",
      "      <message-ids><id>msg-9</id></message-ids>",
      "    </entry>",
      "",
    ].join("\n")
    const text = filledXml.replace("  </timeline>", `${broken}  </timeline>`)
    const result = parseReviewXml(text)
    expect(result.ok).toBe(true)
    if (result.ok) {
      const timeline = result.value.lenses.find((lens) => lens.lens === "timeline")
      expect(timeline?.entries.map((entry) => entry.id)).toEqual(["setup-explored"])
      expect(result.recovered).toContain('dropped <entry id="broken">')
    }
  })

  test("X21: every entry dropped is a failure, not an empty timeline", () => {
    const text = filledXml.replace('from-seq="0" to-seq="6"', 'from-seq="0" to-seq="oops"')
    const result = parseReviewXml(text)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toMatch(/timeline/i)
      expect(result.recovered).toContain('dropped <entry id="setup-explored">')
    }
  })

  test("X22: an unknown element is dropped whole and recorded", () => {
    const text = filledXml.replace(
      "      <title>Explored the repo</title>",
      "      <confidence>0.9</confidence>\n      <title>Explored the repo</title>",
    )
    const result = parseReviewXml(text)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.lenses[0]).toEqual(goldenLenses[0])
      expect(result.recovered).toContain("dropped unknown element <confidence>")
    }
  })

  test("X23: over-long text is truncated to its schema max and recorded", () => {
    const text = filledXml.replace(
      "The session shipped a small fix after one mid-course correction.",
      "x".repeat(700),
    )
    const result = parseReviewXml(text)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.summary).toHaveLength(600)
      expect(result.recovered).toContain("truncated summary")
    }
  })

  test("X24: camelCase attribute spellings and the message-ids attribute form are accepted", () => {
    const text = filledXml
      .replace(
        '<entry id="setup-explored" kind="phase" from-seq="0" to-seq="6" tracks="main">',
        '<entry id="setup-explored" kind="phase" fromSeq="0" toSeq="6" tracks="main" messageIds="msg-0,msg-3">',
      )
      .replace(
        "      <message-ids>\n        <id>msg-0</id>\n        <id>msg-3</id>\n      </message-ids>\n",
        "",
      )
      .replace('message-id="msg-7"', 'messageId="msg-7"')
    const result = parseReviewXml(text)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.lenses[0]).toEqual(goldenLenses[0])
      expect(result.recovered).toEqual([])
    }
  })

  test("X25: a stray close tag for a never-opened tag is dropped and recorded", () => {
    const text = filledXml.replace("</review>", "  </timeline>\n</review>")
    const result = parseReviewXml(text)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.recovered).toContain("dropped stray </timeline>")
      expect(result.value.lenses).toEqual(goldenLenses)
    }
  })

  test("X26: missing model/harness default to the ? placeholder and are recorded", () => {
    const text = filledXml.replace(' model="?"', "").replace(' harness="?"', "")
    const result = parseReviewXml(text)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.model).toBe("?")
      expect(result.value.harness).toBe("?")
      expect(result.recovered).toContain("defaulted model")
      expect(result.recovered).toContain("defaulted harness")
    }
  })

  test("X27: output with no review element at all is a named failure", () => {
    const result = parseReviewXml("I could not review this session, sorry.")
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toMatch(/review/)
      expect(result.recovered).toEqual([])
    }
  })

  test("X28: a dropped learnings opener is reinserted around its children", () => {
    for (const section of ["humanLearnings", "agentLearnings", "breadcrumbs"]) {
      const text = filledXml.replace(`  <${section}>\n`, "")
      const result = parseReviewXml(text)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value.lenses).toEqual(goldenLenses)
        expect(result.recovered).toContain(`inserted missing <${section}> opener`)
      }
    }
  })

  test("X29: a stray learnings closer with no children is a dropped section, named and accounted", () => {
    const text = filledXml.replace(
      / {2}<humanLearnings>[\s\S]*?<\/humanLearnings>/,
      "  </humanLearnings>",
    )
    const result = parseReviewXml(text)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.recovered).toContain("dropped stray </humanLearnings>")
    expect(result.recovered).toContain("dropped:humanLearnings")
    expect(result.value.partial).toEqual({
      claimed: matchingCounts,
      parsed: { timeline: 1, human: 0, agent: 1, breadcrumbs: 1 },
    })
  })

  test("X30: a legacy <lenses> wrapper around the sections is hoisted and recorded", () => {
    const sections = filledXml
      .slice(filledXml.indexOf("  <timeline>"), filledXml.lastIndexOf("  <counts"))
      .trimEnd()
    const v1Shape = `<?xml version="1.0" encoding="UTF-8"?>\n<review outcome="shipped" friction="moderate" model="?" harness="?">\n  <summary>The session shipped a small fix after one mid-course correction.</summary>\n  <lenses>\n${sections}\n  </lenses>\n  <counts timeline="1" human="1" agent="1" breadcrumbs="1"/>\n</review>\n`
    const result = parseReviewXml(v1Shape)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.lenses).toEqual(goldenLenses)
    expect(result.recovered).toContain("hoisted sections from legacy <lenses> wrapper")
  })
})

describe("XML vocabulary constants", () => {
  test("X31: the root and vocabulary constants are the documented contract", () => {
    expect(REVIEW_XML_ROOT).toBe("review")
    for (const tag of [
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
    ]) {
      expect(REVIEW_XML_TAGS).toContain(tag)
    }
  })
})

describe("root attribute synonym healing", () => {
  const withAttrs = (outcome: string, friction: string) =>
    filledXml
      .replace('outcome="shipped"', `outcome="${outcome}"`)
      .replace('friction="moderate"', `friction="${friction}"`)

  test("X32: friction synonyms normalize instead of failing the whole review", () => {
    for (const [given, expectTo] of [
      ["overcome", "moderate"],
      ["Overcome", "moderate"],
      [" low ", "moderate"],
      ["minimal", "none"],
      ["heavy", "high"],
    ] as const) {
      const result = parseReviewXml(withAttrs("shipped", given))
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value.friction).toBe(expectTo)
      expect(result.recovered.some((r) => r.includes("normalized friction"))).toBe(true)
    }
  })

  test("X33: outcome synonyms normalize and are recorded", () => {
    for (const [given, expectTo] of [
      ["completed", "shipped"],
      ["delivered", "shipped"],
      ["complete", "shipped"],
      // The near-misses live models write: something landed, incompletely.
      ["partial", "shipped"],
      ["mixed", "shipped"],
    ] as const) {
      const result = parseReviewXml(withAttrs(given, "moderate"))
      expect(result.ok).toBe(true)
      if (result.ok) expect(result.value.outcome).toBe(expectTo)
      expect(result.recovered.some((r) => r.includes("normalized outcome"))).toBe(true)
    }
  })

  test("X34: an unknown outcome still fails visibly rather than guessing", () => {
    const result = parseReviewXml(withAttrs("sideways", "moderate"))
    expect(result.ok).toBe(false)
  })

  test("X35: an unknown friction falls back to moderate and is recorded", () => {
    const result = parseReviewXml(withAttrs("shipped", "spicy"))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.friction).toBe("moderate")
    expect(result.recovered.some((r) => r.includes('normalized friction "spicy"'))).toBe(true)
  })

  test("X36: the canonical friction none passes through untouched - the template's own example value", () => {
    const result = parseReviewXml(withAttrs("shipped", "none"))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.friction).toBe("none")
    expect(result.recovered).toEqual([])
  })
})
