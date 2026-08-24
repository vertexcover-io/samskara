import type { Sql } from "postgres"
import { describe, expect, test } from "vitest"
import { MIGRATION_STEPS, type MigrationStep, type StepContext, runSteps } from "./steps.js"

const context = (...flags: ReadonlyArray<string>): StepContext => ({
  client: {} as Sql,
  flags: new Set(flags),
})

const recorder = (calls: Array<string>, name: string): MigrationStep => ({
  name,
  run: async () => {
    calls.push(`run:${name}`)
  },
  verify: async () => {
    calls.push(`verify:${name}`)
  },
})

const silent = (): void => {}

describe("runSteps", () => {
  test("applies every step in the order it is registered", async () => {
    const calls: Array<string> = []
    await runSteps([recorder(calls, "first"), recorder(calls, "second")], context(), silent)
    expect(calls).toEqual(["run:first", "run:second"])
  })

  test("--verify reads instead of writing, so it is safe against a live database", async () => {
    const calls: Array<string> = []
    await runSteps([recorder(calls, "first")], context("verify"), silent)
    expect(calls).toEqual(["verify:first"])
  })

  test("stops at the first failure rather than reporting a later step's success", async () => {
    const calls: Array<string> = []
    const failing: MigrationStep = {
      name: "failing",
      run: async () => {
        throw new Error("boom")
      },
      verify: async () => {},
    }
    await expect(runSteps([failing, recorder(calls, "after")], context(), silent)).rejects.toThrow(
      "boom",
    )
    expect(calls).toEqual([])
  })

  test("names the step before running it, so a slow index build is attributable", async () => {
    const logged: Array<string> = []
    await runSteps([recorder([], "search-indexes")], context(), (line) => logged.push(line))
    expect(logged.join("\n")).toContain("search-indexes")
  })

  test("passes the flags through so a step can take a mode", async () => {
    const seen: Array<boolean> = []
    const step: MigrationStep = {
      name: "flagged",
      run: async ({ flags }) => {
        seen.push(flags.has("drop-stale"))
      },
      verify: async () => {},
    }
    await runSteps([step], context("drop-stale"), silent)
    expect(seen).toEqual([true])
  })
})

describe("MIGRATION_STEPS", () => {
  test("every registered step has a unique non-empty name", () => {
    const names = MIGRATION_STEPS.map((step) => step.name)
    expect(names.every((name) => name.length > 0)).toBe(true)
    expect(new Set(names).size).toBe(names.length)
  })

  test("registers the search indexes drizzle-kit cannot build in a transaction", () => {
    expect(MIGRATION_STEPS.map((step) => step.name)).toContain("search-indexes")
  })
})
