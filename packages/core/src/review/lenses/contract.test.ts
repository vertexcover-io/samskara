import { describe, expect, test } from "vitest"
import { reviewContractMd } from "./contract.js"

describe("reviewContractMd", () => {
  /** Prose wraps; assertions match phrases across line breaks. */
  const flat = (): string => reviewContractMd().replace(/\s+/g, " ")

  test("C1: is deterministic", () => {
    expect(reviewContractMd()).toBe(reviewContractMd())
  })

  test("C2: states the verdict enums as exact words only, with definitions", () => {
    const contract = reviewContractMd()
    for (const word of ["shipped", "productive", "struggled", "aborted"]) {
      expect(contract).toContain(word)
    }
    expect(contract).toContain("the work landed")
    expect(contract).toContain("real work happened, nothing landed")
    expect(contract).toMatch(/friction[^\n]*none[^\n]*moderate[^\n]*high/)
    expect(contract).toContain('not "partial"')
  })

  test("C3: the sections are pre-created and extendable - never invent new top-level sections", () => {
    const contract = reviewContractMd()
    for (const section of [
      "summary",
      "timeline",
      "humanLearnings",
      "agentLearnings",
      "breadcrumbs",
      "counts",
    ]) {
      expect(contract).toContain(section)
    }
    expect(contract).toContain("Never")
    expect(contract).toContain("invent new top-level sections")
  })

  test("C4: teaches write-forward assembly, node-only scripts, and inline validation", () => {
    const contract = flat()
    expect(contract).toContain("writing as you go")
    expect(contract).toContain("Do not compose the whole review in your head")
    expect(contract).toContain("node <<'JS'")
    expect(contract).toContain("no python, no xmllint")
    expect(contract).toContain("programmatically, never by hand")
    expect(contract).toContain("the file is the deliverable")
  })

  test("C5: spells the two audiences, the no-praise rule, the breadcrumbs rule, and grounding", () => {
    const contract = flat()
    expect(contract).toContain("what the person could do differently")
    expect(contract).toContain("what the agent could do better")
    expect(contract).toContain("A learning must name a change, not a compliment")
    expect(contract).toContain("say so in the summary")
    expect(contract).toContain("A breadcrumb is not a correction; it is a map marker")
    expect(contract).toContain("standard enough to be worth keeping")
    expect(contract).toContain("cite where in the transcript it was worked out")
    expect(contract).toContain("Nothing to change")
    expect(contract).toContain("Never invent ids")
    expect(contract).toContain("the server checks every reference")
    expect(contract).toContain("If the evidence is thin, say less")
  })

  test("C6: names session.json as the only data source, and guards the meta-confusion", () => {
    const contract = flat()
    expect(contract).toContain("only data source")
    expect(contract).toContain("not the task of reviewing")
    expect(contract).toContain("not any session the transcript merely talks about")
  })
})
