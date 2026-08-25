import { describe, expect, test } from "vitest"
import {
  databaseName,
  pickOffset,
  RESERVED_OFFSETS,
  recordedDatabase,
  replaceDatabase,
  slugify,
  teardownDatabase,
  worktreeEnv,
} from "./worktree-env.js"

describe("slugify", () => {
  test("turns a branch name into a postgres-safe identifier", () => {
    expect(slugify("feat/session-search")).toMatch(/^feat_session_search_[a-z0-9]+$/)
  })

  test("lowercases and collapses runs of separators", () => {
    expect(slugify("Feat//Session--Search")).toMatch(/^feat_session_search_[a-z0-9]+$/)
  })

  test("is deterministic, so a branch keeps its database across runs", () => {
    expect(slugify("feat/session-search")).toBe(slugify("feat/session-search"))
  })

  test("never leaves a leading or trailing underscore", () => {
    expect(slugify("/feat/x/")).toMatch(/^feat_x_[a-z0-9]+$/)
  })

  test("truncates long branches without leaving a trailing underscore", () => {
    const slug = slugify(`feat/${"a".repeat(30)}/${"b".repeat(30)}`)
    expect(slug.length).toBeLessThanOrEqual(40)
    expect(slug.endsWith("_")).toBe(false)
  })

  test("falls back rather than producing an empty identifier", () => {
    expect(slugify("///")).toMatch(/^wt_[a-z0-9]+$/)
  })

  // Two worktrees on one database is the exact failure per-branch databases exist to prevent, and
  // a collision is silent: `ensureDatabase` just reports "reusing".
  test("separates branches that differ only in their separators", () => {
    expect(slugify("feat/a-b")).not.toBe(slugify("feat/a_b"))
  })

  test("separates long branches that share a truncated prefix", () => {
    const one = slugify("feat/worktree-db-isolation-and-a-very-long-tail-one")
    const two = slugify("feat/worktree-db-isolation-and-a-very-long-tail-two")
    expect(one).not.toBe(two)
    expect(one.length).toBeLessThanOrEqual(40)
  })

  test("separates branches that differ only in case", () => {
    expect(slugify("feat/Thing")).not.toBe(slugify("feat/thing"))
  })
})

describe("recordedDatabase", () => {
  test("reads the database setup actually wrote", () => {
    expect(
      recordedDatabase("DATABASE_URL=postgres://u:p@localhost:5433/samskara_feat_alpha\n"),
    ).toBe("samskara_feat_alpha")
  })

  test("is undefined when the worktree records no DATABASE_URL", () => {
    expect(recordedDatabase("PORT=3042\n")).toBeUndefined()
  })

  test("is undefined rather than throwing on a url it cannot parse", () => {
    expect(recordedDatabase("DATABASE_URL=not-a-url\n")).toBeUndefined()
  })
})

describe("teardownDatabase", () => {
  // `git branch -m` inside a worktree used to orphan the original database forever, because
  // teardown re-derived the name from whatever branch happened to be checked out.
  test("prefers the recorded database over the current branch name", () => {
    expect(
      teardownDatabase({
        recorded: "samskara_feat_alpha",
        branch: "feat/renamed",
        mainDatabase: "samskara",
      }),
    ).toBe("samskara_feat_alpha")
  })

  test("falls back to the branch when the worktree recorded nothing", () => {
    expect(
      teardownDatabase({ recorded: undefined, branch: "feat/x", mainDatabase: "samskara" }),
    ).toBe(databaseName(slugify("feat/x")))
  })

  // A worktree whose .env is still a symlink to the main checkout records the main DATABASE_URL,
  // and dropping that would destroy every branch's data at once.
  test("refuses to drop the main checkout's database", () => {
    expect(() =>
      teardownDatabase({ recorded: "samskara", branch: "feat/x", mainDatabase: "samskara" }),
    ).toThrow(/main checkout/)
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
