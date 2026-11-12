import { expect, test } from "vitest"
import { parseProjectPath } from "./ProjectTabs.js"

test.each([
  ["", { tab: "overview", runId: null }],
  ["fixes", { tab: "fixes", runId: null }],
  ["fixes/", { tab: "fixes", runId: null }],
  ["nope", null],
  ["fixes/x", null],
  ["overview", null],
  ["runs", null],
  ["runs/r-1", null],
])(
  "SC702: parseProjectPath(%j) reads the tab, or null for a path no listed tab owns",
  (rest, expected) => {
    expect(parseProjectPath(rest)).toEqual(expected)
  },
)
