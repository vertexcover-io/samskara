import { describe, expect, test } from "vitest"
import { checkpointSchema } from "./types.js"

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
})
