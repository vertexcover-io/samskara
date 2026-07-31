import { expect, test } from "vitest"
import { type ParsedRecord, ingestPayloadSchema, projectIdentitySchema } from "./types.js"

const records: ReadonlyArray<ParsedRecord> = [
  {
    lineUuid: "0191d942-3ba5-7dba-9a7d-22d65b30258c",
    lineNumber: 1,
    raw: {},
    messages: [
      {
        subIndex: 0,
        sessionId: "sess-1",
        source: "claude_code",
        sourceSchemaVersion: 1,
        trackId: "main",
        msgType: "custom",
        subType: "fixture",
      },
    ],
  },
]

const base = {
  sessionId: "sess-1",
  project: { name: "widget", slug: "acme-widget" },
  sourceRelativePath: "sess-1.jsonl",
  records,
} as const

test("S15: a payload whose project omits root still validates", () => {
  const parsed = ingestPayloadSchema.safeParse({ ...base, type: "main" })

  expect(parsed.success).toBe(true)
  expect(parsed.success && parsed.data.project.root).toBeUndefined()
})

test("S15: a payload whose project carries a root validates and preserves it", () => {
  const parsed = ingestPayloadSchema.safeParse({
    ...base,
    type: "main",
    project: { ...base.project, root: "/work/app" },
  })

  expect(parsed.success).toBe(true)
  expect(parsed.success && parsed.data.project.root).toBe("/work/app")
})

// The schema is strict and sits in the ingest wire payload, so an unknown key must still be
// rejected -- adding `root` widened the shape by exactly one optional field, nothing more.
test("S15: the strict project schema still rejects an unknown key", () => {
  expect(projectIdentitySchema.safeParse({ name: "w", slug: "a-w", branch: "main" }).success).toBe(
    false,
  )
})

test("S15: the project schema rejects an empty root rather than storing a meaningless path", () => {
  expect(projectIdentitySchema.safeParse({ name: "w", slug: "a-w", root: "" }).success).toBe(false)
})
