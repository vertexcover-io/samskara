import { expect, test } from "vitest"
import { parseProjectPath } from "./ProjectTabs.js"

test.each([
  ["", { tab: "overview", runId: null }],
  ["fixes", { tab: "fixes", runId: null }],
  ["fixes/", { tab: "fixes", runId: null }],
  ["nope", null],
  ["fixes/x", null],
  ["overview", null],
  ["runs", { tab: "runs", runId: null }],
  ["runs/r-1", { tab: "runs", runId: "r-1" }],
  ["runs/a%b", { tab: "runs", runId: "a%b" }],
  ["runs/r-1/x", null],
  ["fixes/r-1", null],
])(
  "SC702/SC722: parseProjectPath(%j) reads the tab and run, or null for a path no listed tab owns",
  (rest, expected) => {
    expect(parseProjectPath(rest)).toEqual(expected)
  },
)
