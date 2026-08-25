import { expect, test } from "vitest"
import type { SyncStatusRow } from "../api/types.js"
import {
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
