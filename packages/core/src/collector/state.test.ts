import { describe, expect, test } from "vitest"
import { checkpointSchema, checkpointStoreSchema } from "./types.js"

const legacyCheckpoint = {
  filePath: "/sessions/a.jsonl",
  lastUpdatedAt: "2026-07-25T10:00:00.000Z",
  source: "claude_code",
  mtime: 10,
  size: 20,
  lineProcessed: 3,
} as const

describe("checkpoint project identity", () => {
  test("REQ-031: legacy checkpoints without projectSlug remain valid", () => {
    expect(checkpointSchema.safeParse(legacyCheckpoint).success).toBe(true)
  })

  test("REQ-030: checkpoints accept the persisted project slug", () => {
    const parsed = checkpointSchema.safeParse({ ...legacyCheckpoint, projectSlug: "acme-widget" })

    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.projectSlug).toBe("acme-widget")
  })

  test("SC11: the store schema carries an optional apiBase, so the CLI's stamp survives a parse", () => {
    const parsed = checkpointStoreSchema.safeParse({
      checkpoints: { "/a.jsonl": legacyCheckpoint },
      apiBase: "https://one.example",
    })

    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.apiBase).toBe("https://one.example")

    // Not `.strict()`: a store written before this field existed must keep parsing.
    const legacy = checkpointStoreSchema.safeParse({ checkpoints: {} })
    expect(legacy.success).toBe(true)
    if (legacy.success) expect(legacy.data.apiBase).toBeUndefined()
  })
})
