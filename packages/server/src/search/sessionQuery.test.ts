import { sql } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import type { Db } from "../db/client.js"
import { dockerAvailable, startEmptyTestDb } from "../db/testDb.js"
import { compileSessionQuery, parseSessionQuery, SessionQueryError } from "./sessionQuery.js"

const operands = (value: string) =>
  parseSessionQuery(value).branches.map((branch) => branch.operands)

describe("parseSessionQuery", () => {
  test("selects the final positive unquoted term in each OR branch for prefix matching", () => {
    expect(operands("auth gua OR session ind")).toEqual([
      [
        { value: "auth", phrase: false, excluded: false, prefix: false },
        { value: "gua", phrase: false, excluded: false, prefix: true },
      ],
      [
        { value: "session", phrase: false, excluded: false, prefix: false },
        { value: "ind", phrase: false, excluded: false, prefix: true },
      ],
    ])
  })

  test("keeps phrases and exclusions whole-word while supporting Unicode", () => {
    expect(operands('"auth guard" sess -legacy OR naïve café')).toEqual([
      [
        { value: "auth guard", phrase: true, excluded: false, prefix: false },
        { value: "sess", phrase: false, excluded: false, prefix: true },
        { value: "legacy", phrase: false, excluded: true, prefix: false },
      ],
      [
        { value: "naïve", phrase: false, excluded: false, prefix: false },
        { value: "café", phrase: false, excluded: false, prefix: true },
      ],
    ])
  })

  test("treats unquoted punctuation as separators rather than operators", () => {
    expect(operands("auth;guard & session")).toEqual([
      [
        { value: "auth", phrase: false, excluded: false, prefix: false },
        { value: "guard", phrase: false, excluded: false, prefix: false },
        { value: "session", phrase: false, excluded: false, prefix: true },
      ],
    ])
  })

  test.each([
    "",
    "OR auth",
    "auth OR",
    "auth OR OR session",
    '"unterminated',
    '""',
    "-",
    "- OR auth",
    "___ auth",
    "auth ___",
    "auth -___",
    '"___" auth',
    'auth "___"',
    'auth -"___"',
    "¹ auth",
    "auth ¹",
    "auth -¹",
  ])("rejects invalid grammar: %j", (value) => {
    expect(() => parseSessionQuery(value)).toThrow(SessionQueryError)
  })

  test("compiles with PostgreSQL tsquery operators, not tsquery text operators", () => {
    const compiled = compileSessionQuery(parseSessionQuery('"auth guard" sess -legacy OR main'))
    const chunks = compiled.queryChunks.map((chunk) => String(chunk)).join(" ")
    expect(chunks).not.toContain(" & ")
    expect(chunks).not.toContain(" | ")
    expect(chunks).not.toContain("!(")
  })
})

describe.skipIf(!dockerAvailable())("compileSessionQuery against PostgreSQL", () => {
  let teardown: () => Promise<void>
  let db: Db

  beforeAll(async () => {
    const started = await startEmptyTestDb()
    db = started.db
    teardown = started.teardown
  }, 120_000)

  afterAll(async () => {
    await teardown?.()
  })

  const matches = async (query: string, document: string): Promise<boolean> => {
    const compiled = compileSessionQuery(parseSessionQuery(query))
    const [row] = await db.execute<{ readonly matches: boolean }>(
      sql`select to_tsvector('simple'::regconfig, ${document}) @@ ${compiled} as matches`,
    )
    return row?.matches ?? false
  }

  test("executes AND, OR, exclusion, and final-term prefix queries", async () => {
    await expect(matches("auth guard", "auth guardian")).resolves.toBe(true)
    await expect(matches("auth guard", "auth legacy")).resolves.toBe(false)
    await expect(matches("auth OR session", "session data")).resolves.toBe(true)
    await expect(matches("auth -legacy", "auth current")).resolves.toBe(true)
    await expect(matches("auth -legacy", "auth legacy")).resolves.toBe(false)
  })

  test("rejects zero-lexeme operands before PostgreSQL in final, non-final, and excluded positions", async () => {
    for (const query of [
      "___ auth",
      "auth ___",
      "auth -___",
      '"___" auth',
      'auth "___"',
      'auth -"___"',
      "¹ auth",
      "auth ¹",
      "auth -¹",
    ]) {
      expect(() => parseSessionQuery(query)).toThrow(SessionQueryError)
    }
  })

  test("executes normalized multi-lexeme operands only where they cannot receive a prefix", async () => {
    // PostgreSQL normalizes auth_guard to two lexemes under simple. It is valid as a non-final
    // AND operand and as an exclusion, but invalid as the final positive prefix operand.
    await expect(matches("auth_guard tail", "auth guard tail")).resolves.toBe(true)
    await expect(matches("tail -auth_guard", "tail current")).resolves.toBe(true)
    await expect(matches("tail -auth_guard", "tail auth guard")).resolves.toBe(false)
    expect(() => parseSessionQuery("tail auth_guard")).toThrow(SessionQueryError)
    await expect(matches("café", "caféine")).resolves.toBe(true)
    await expect(matches('"auth guard"', "auth guardrails")).resolves.toBe(false)
  })
})
