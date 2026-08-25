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
    const vectors = SEARCH_DOCUMENTS.map((document) => document.vector).join("\n")
    expect(vectors).toContain("public.samskara_search_cap")
    expect(vectors).toContain("public.samskara_search_json_text")
    expect(vectors).not.toContain("samskara_search_document")
    expect(vectors).not.toContain("concat_ws")
    expect(vectors).not.toContain('"messages"."raw"')
    expect(vectors).not.toContain('"pullRequests"."number"')
  })

  test("derives every vector from its text, so the stored column, the rank and the headline agree", () => {
    for (const document of SEARCH_DOCUMENTS) {
      expect(document.vector).toBe(
        `to_tsvector('simple'::regconfig, public.samskara_search_cap(${document.text}))`,
      )
    }
  })

  test("versions canonical replacements as V3 indexes", () => {
    expect(SEARCH_DOCUMENTS.every((document) => document.indexName.endsWith("_v3_idx"))).toBe(true)
  })

  test("indexes the stored searchVector column with fastupdate off, never an expression", () => {
    for (const document of SEARCH_DOCUMENTS) {
      expect(searchIndexDefinition(document)).toBe(
        `create index "${document.indexName}" on "${document.table}" using gin ("searchVector") with (fastupdate=off)`,
      )
    }
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
