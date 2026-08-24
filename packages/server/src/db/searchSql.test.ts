import { describe, expect, test } from "vitest"
import {
  filterIndexDefinition,
  normalizeIndexDefinition,
  SEARCH_DOCUMENTS,
  SEARCH_FILTER_INDEXES,
  searchIndexDefinition,
} from "./searchSql.js"

describe("searchSql", () => {
  test("defines exactly the five approved keyword documents and multipliers", () => {
    expect(
      SEARCH_DOCUMENTS.map(({ sourceKind, table, multiplier }) => ({
        sourceKind,
        table,
        multiplier,
      })),
    ).toEqual([
      { sourceKind: "session", table: "sessions", multiplier: 4 },
      { sourceKind: "message", table: "messages", multiplier: 1.5 },
      { sourceKind: "pullRequest", table: "pullRequests", multiplier: 3 },
      { sourceKind: "toolCall", table: "toolCall", multiplier: 1 },
      { sourceKind: "toolResult", table: "toolResult", multiplier: 0.75 },
    ])
  })

  test("uses capped scalar-only source documents and immutable index-safe concatenation", () => {
    const definitions = SEARCH_DOCUMENTS.map(searchIndexDefinition).join("\n")
    expect(definitions).toContain("public.samskara_search_cap")
    expect(definitions).toContain("public.samskara_search_json_text")
    expect(definitions).not.toContain("samskara_search_document")
    expect(definitions).not.toContain("concat_ws")
    expect(definitions).not.toContain('"messages"."raw"')
    expect(definitions).not.toContain('"pullRequests"."number"')
  })

  test("versions canonical replacements as V2 indexes", () => {
    expect(SEARCH_DOCUMENTS.every((document) => document.indexName.endsWith("_v2_idx"))).toBe(true)
  })

  test("builds one canonical definition per expected concurrent index", () => {
    expect(SEARCH_DOCUMENTS.map(searchIndexDefinition)).toHaveLength(5)
    expect(SEARCH_FILTER_INDEXES.map(filterIndexDefinition)).toHaveLength(7)
    expect(SEARCH_FILTER_INDEXES.map(filterIndexDefinition)).toContain(
      'create index "commits_session_filter_sha_v1_idx" on "commits" (lower("sha") text_pattern_ops, "sessionId")',
    )
  })

  test("normalizes PostgreSQL deparser formatting while preserving structural nesting", () => {
    const expected = 'create index "x" on "messages" ((lower("sha")) text_pattern_ops, "sessionId")'
    const deparsed =
      'CREATE INDEX x ON public.messages USING btree ((lower(sha)) text_pattern_ops, "sessionId")'
    expect(normalizeIndexDefinition(deparsed)).toContain(
      normalizeIndexDefinition('((lower("sha")) text_pattern_ops, "sessionId")'),
    )
    expect(normalizeIndexDefinition(expected)).toContain(
      normalizeIndexDefinition('((lower("sha")) text_pattern_ops, "sessionId")'),
    )
  })

  test("does not erase nesting drift from canonical index definitions", () => {
    const nested = "create index x on messages using gin ((to_tsvector('simple', lower(title))))"
    const flattened = "create index x on messages using gin (to_tsvector('simple', lower(title)))"
    const differentlyNested =
      "create index x on messages using gin ((to_tsvector('simple', (lower(title)))))"
    expect(normalizeIndexDefinition(nested)).not.toBe(normalizeIndexDefinition(flattened))
    expect(normalizeIndexDefinition(nested)).not.toBe(normalizeIndexDefinition(differentlyNested))
  })
})
