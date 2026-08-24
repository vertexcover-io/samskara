import { describe, expect, test } from "vitest"
import {
  RESERVED_OFFSETS,
  databaseName,
  pickOffset,
  replaceDatabase,
  slugify,
  worktreeEnv,
} from "./worktree-env.js"

describe("slugify", () => {
  test("turns a branch name into a postgres-safe identifier", () => {
    expect(slugify("feat/session-search")).toBe("feat_session_search")
  })

  test("lowercases and collapses runs of separators", () => {
    expect(slugify("Feat//Session--Search")).toBe("feat_session_search")
  })

  test("never leaves a leading or trailing underscore", () => {
    expect(slugify("/feat/x/")).toBe("feat_x")
  })

  test("truncates long branches without leaving a trailing underscore", () => {
    const slug = slugify(`feat/${"a".repeat(30)}/${"b".repeat(30)}`)
    expect(slug.length).toBeLessThanOrEqual(40)
    expect(slug.endsWith("_")).toBe(false)
  })

  test("falls back rather than producing an empty identifier", () => {
    expect(slugify("///")).toBe("wt")
  })
})

describe("databaseName", () => {
  test("namespaces the slug and stays inside postgres' 63 char limit", () => {
    expect(databaseName("feat_x")).toBe("samskara_feat_x")
    expect(databaseName(slugify("a".repeat(80))).length).toBeLessThanOrEqual(63)
  })
})

describe("replaceDatabase", () => {
  test("swaps only the database, keeping credentials host and port", () => {
    expect(
      replaceDatabase("postgres://samskara:samskara@localhost:5433/samskara", "samskara_feat_x"),
    ).toBe("postgres://samskara:samskara@localhost:5433/samskara_feat_x")
  })
})

describe("pickOffset", () => {
  test("is deterministic for the same slug", () => {
    expect(pickOffset("feat_x", new Set())).toBe(pickOffset("feat_x", new Set()))
  })

  test("gives different slugs different offsets", () => {
    expect(pickOffset("feat_x", new Set())).not.toBe(pickOffset("feat_y", new Set()))
  })

  test("probes past an offset another worktree already holds", () => {
    const first = pickOffset("feat_x", new Set())
    expect(pickOffset("feat_x", new Set([first]))).not.toBe(first)
  })

  test("never hands out an offset the e2e stack has reserved", () => {
    for (const reserved of RESERVED_OFFSETS) {
      const slugs = ["a", "b", "c", "feat_x", "feat_y", "chore_z"]
      for (const slug of slugs) expect(pickOffset(slug, new Set())).not.toBe(reserved)
    }
  })

  test("stays in a range that keeps server and web ports from overlapping", () => {
    const offset = pickOffset("feat_x", new Set())
    expect(offset).toBeGreaterThanOrEqual(1)
    expect(offset).toBeLessThanOrEqual(400)
  })
})

describe("worktreeEnv", () => {
  const env = worktreeEnv({
    baseDatabaseUrl: "postgres://samskara:samskara@localhost:5433/samskara",
    slug: "feat_x",
    offset: 42,
  })

  test("points the database at the branch's own database", () => {
    expect(env.DATABASE_URL).toBe("postgres://samskara:samskara@localhost:5433/samskara_feat_x")
  })

  test("offsets both ports by the same amount so the pair stays predictable", () => {
    expect(env.PORT).toBe("3042")
    expect(env.WEB_PORT).toBe("8042")
  })

  test("aims every api url at this worktree's own server port", () => {
    expect(env.API_PROXY_TARGET).toBe("http://localhost:3042")
    expect(env.PUBLIC_BASE_URL).toBe("http://localhost:3042")
    expect(env.VITE_API_BASE_URL).toBe("http://localhost:3042")
    expect(env.WEB_BASE_URL).toBe("http://localhost:8042")
  })
})
