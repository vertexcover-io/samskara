import { expect, test } from "vitest"
import { runWork } from "./labels.js"

test.each([
  [1, 2, "1 new fix, 2 updated"],
  [2, 0, "2 new fixes, 0 updated"],
  [0, 1, "0 new fixes, 1 updated"],
])("SC723: runWork(%i, %i) says %j", (created, updated, expected) => {
  expect(runWork(created, updated)).toBe(expected)
})
