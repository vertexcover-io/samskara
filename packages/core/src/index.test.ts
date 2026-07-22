import { expect, test } from "vitest"
import type { Placeholder } from "./index.js"

test("core placeholder type is inhabitable", () => {
  const value: Placeholder = { _brand: "samskara-core-placeholder" }
  expect(value._brand).toBe("samskara-core-placeholder")
})
