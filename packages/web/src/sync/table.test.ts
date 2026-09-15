import { expect, test } from "vitest"
import type { SyncStatusRow } from "../api/types.js"
import {
  compareVersions,
  DEFAULT_STATE,
  filterRows,
  nextDirection,
  projectOptions,
  sortRows,
  userOptions,
} from "./table.js"

const row = (overrides: Partial<SyncStatusRow>): SyncStatusRow => ({
  userId: "u-1",
  githubLogin: "ritesh",
  name: null,
  avatarUrl: null,
  projectId: "p-1",
  projectName: "Samskara",
  projectSlug: "samskara",
  sessionCount: 1,
  lastSyncedAt: "2026-08-20T10:00:00.000Z",
  cliVersion: "0.4.2",
  cliVersionSince: "2026-08-13T10:00:00.000Z",
  ...overrides,
})

test("SC14: the default order is newest sync first, with never-synced rows last", () => {
  const older = row({ userId: "u-2", lastSyncedAt: "2026-08-18T10:00:00.000Z" })
  const newer = row({ userId: "u-3", lastSyncedAt: "2026-08-20T10:00:00.000Z" })
  const never = row({ userId: "u-4", lastSyncedAt: null })

  const sorted = sortRows([older, newer, never], DEFAULT_STATE)

  expect(sorted.map((r) => r.userId)).toEqual(["u-3", "u-2", "u-4"])
})

test("SC15: a second click on the same column reverses the order, and never-synced rows still sort last", () => {
  const older = row({ userId: "u-2", lastSyncedAt: "2026-08-18T10:00:00.000Z" })
  const newer = row({ userId: "u-3", lastSyncedAt: "2026-08-20T10:00:00.000Z" })
  const never = row({ userId: "u-4", lastSyncedAt: null })

  const direction = nextDirection(DEFAULT_STATE, "synced")
  expect(direction).toBe("asc")

  const sorted = sortRows([older, newer, never], { ...DEFAULT_STATE, direction })
  expect(sorted.map((r) => r.userId)).toEqual(["u-2", "u-3", "u-4"])
})

test("SC16: the user filter matches a login or name fragment, ignoring case, and an empty term keeps every row", () => {
  const ritesh = row({ userId: "u-1", githubLogin: "ritesh", name: null })
  const asha = row({ userId: "u-2", githubLogin: "asha", name: "Asha Rai" })

  const byLogin = filterRows([ritesh, asha], { ...DEFAULT_STATE, user: "RIT" })
  expect(byLogin.map((r) => r.userId)).toEqual(["u-1"])

  const byName = filterRows([ritesh, asha], { ...DEFAULT_STATE, user: "rai" })
  expect(byName.map((r) => r.userId)).toEqual(["u-2"])

  expect(filterRows([ritesh, asha], DEFAULT_STATE)).toHaveLength(2)
})

test("SC17: the user and project filters narrow the list together, never past either alone", () => {
  const rows = [
    row({ userId: "u-1", githubLogin: "ritesh", projectName: "Samskara", projectSlug: "samskara" }),
    row({ userId: "u-2", githubLogin: "ritesh-b", projectName: "Other", projectSlug: "other" }),
    row({
      userId: "u-3",
      githubLogin: "ritesh-c",
      projectName: "Samskara",
      projectSlug: "samskara",
    }),
    row({ userId: "u-4", githubLogin: "ritesh-d", projectName: "Zeta", projectSlug: "zeta" }),
    row({ userId: "u-5", githubLogin: "maya", projectName: "Samskara", projectSlug: "samskara" }),
  ]

  const byUser = filterRows(rows, { ...DEFAULT_STATE, user: "ritesh" })
  expect(byUser).toHaveLength(4)
  const byProject = filterRows(rows, { ...DEFAULT_STATE, project: "samskara" })
  expect(byProject).toHaveLength(3)

  const both = filterRows(rows, { ...DEFAULT_STATE, user: "ritesh", project: "samskara" })
  expect(both.map((r) => r.userId)).toEqual(["u-1", "u-3"])
  expect(both.length).toBeLessThanOrEqual(Math.min(byUser.length, byProject.length))
})

test("SC25: the filter suggestions list every user and project once, in alphabetical order", () => {
  const rows = [
    row({ userId: "u-1", githubLogin: "ritesh", projectName: "Zeta", projectSlug: "zeta" }),
    row({ userId: "u-1", githubLogin: "ritesh", projectName: "Andromeda", projectSlug: "and" }),
    row({ userId: "u-2", githubLogin: "asha", projectName: "Zeta", projectSlug: "zeta" }),
  ]

  expect(userOptions(rows)).toEqual(["asha", "ritesh"])
  expect(projectOptions(rows)).toEqual(["Andromeda", "Zeta"])
})

test("SC26: a user holding no project contributes no project suggestion", () => {
  const rows = [
    row({ userId: "u-1", githubLogin: "solo", projectName: null, projectSlug: null }),
    row({ userId: "u-2", githubLogin: "asha", projectName: "Zeta", projectSlug: "zeta" }),
  ]

  expect(projectOptions(rows)).toEqual(["Zeta"])
  expect(userOptions(rows)).toEqual(["asha", "solo"])
})

test("SC39: sorting by CLI version follows the numbers, not the alphabet", () => {
  const oldest = row({ userId: "u-1", cliVersion: "0.9.0" })
  const patched = row({ userId: "u-2", cliVersion: "0.2.13" })
  const newest = row({ userId: "u-3", cliVersion: "0.10.0" })

  expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0)
  expect(compareVersions("0.9.0", "0.2.13")).toBeGreaterThan(0)

  const sorted = sortRows([oldest, patched, newest], { ...DEFAULT_STATE, column: "cli" })
  expect(sorted.map((r) => r.userId)).toEqual(["u-3", "u-1", "u-2"])
})

test("SC39: a prerelease sorts below the release carrying the same numbers", () => {
  const cases: ReadonlyArray<readonly [string, string, "above" | "below"]> = [
    ["1.4.0", "1.4.0-rc.1", "above"],
    ["1.4.0-rc.1", "1.3.9", "above"],
    ["1.4.2-rc.1", "1.4.2", "below"],
    ["1.4.2-rc.1", "1.4.1", "above"],
    ["1.4.0+build.5", "1.4.0", "below"],
    ["1.4.0+build.5", "1.3.9", "above"],
  ]

  for (const [left, right, expected] of cases) {
    const gap = compareVersions(left, right)
    if (expected === "above") expect([left, right, gap > 0]).toEqual([left, right, true])
    else expect([left, right, gap <= 0]).toEqual([left, right, true])
  }
})

test("SC39: build metadata does not change the order", () => {
  expect(compareVersions("1.4.0+build.5", "1.4.0")).toBe(0)
  expect(compareVersions("v1.4.0", "1.4.0")).toBe(0)
})

test("SC39: a string that is not a version sorts below every version", () => {
  expect(compareVersions("dev", "0.0.1")).toBeLessThan(0)
  expect(compareVersions("0.0.1", "dev")).toBeGreaterThan(0)
  expect(compareVersions("dev", "nightly")).toBe(0)
})

test("SC40: rows with no recorded version sort last in both directions", () => {
  const versioned = row({ userId: "u-1", cliVersion: "0.4.2" })
  const unknown = row({ userId: "u-2", cliVersion: null, cliVersionSince: null })

  const descending = sortRows([unknown, versioned], { ...DEFAULT_STATE, column: "cli" })
  expect(descending.map((r) => r.userId)).toEqual(["u-1", "u-2"])

  const ascending = sortRows([unknown, versioned], {
    ...DEFAULT_STATE,
    column: "cli",
    direction: "asc",
  })
  expect(ascending.map((r) => r.userId)).toEqual(["u-1", "u-2"])
})
