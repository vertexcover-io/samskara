import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"

const source = readFileSync(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf-8")

describe("server boot", () => {
  test("S12: index.ts contains no console.log and references the root logger", () => {
    expect(source).not.toMatch(/console\.log/)
    expect(source).toMatch(/rootLog/)
  })
})
