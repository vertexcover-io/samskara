import { expect, test } from "vitest"
import { parseSessionArtifacts, parseSessionList, parseSyncStatusRows } from "./parse.js"
import type { CapturedArtifact } from "./types.js"

const ROW = {
  id: "cap-1",
  path: "/work/acme/docs/notes.md",
  relativePath: "docs/notes.md",
  mimeType: "text/markdown",
  isBinary: false,
  changeKind: "edited",
  diff: "@@ -1 +1 @@\n-old\n+new\n",
  oldFragment: null,
  editCount: 2,
  byteSize: 42,
  hasBase: true,
  firstSeenAt: "2026-07-01T10:00:00.000Z",
  lastSeenAt: "2026-07-01T10:05:00.000Z",
}

const session = {
  id: "s-1",
  title: "Search evidence",
  projectName: "Samskara",
  projectSlug: "samskara",
  userLogin: "maya",
  repo: null,
  durationMs: 1_000,
  tokensTotal: 42,
  status: "complete",
  lastActiveAt: "2026-08-20T10:00:00.000Z",
}

const listPayload = {
  sessions: [
    {
      ...session,
      match: {
        sourceKind: "toolResult",
        sourceRowId: "call-1",
        snippet: [
          { text: "deployment ", highlighted: false },
          { text: "timeout", highlighted: true },
        ],
      },
    },
  ],
  pagination: { page: 1, limit: 25, total: 1, totalPages: 1 },
  filterOptions: {
    projects: [{ value: "samskara", label: "Samskara" }],
    authors: [{ value: "maya", label: "maya" }],
    repositories: [
      {
        value: "r-1",
        label: "acme/samskara",
        host: "github.com",
        owner: "acme",
        repoName: "samskara",
      },
    ],
    branches: ["main"],
  },
}

test("S48: a well-formed artifacts response parses into the CapturedArtifact shape the view consumes", () => {
  const parsed = parseSessionArtifacts({ artifacts: [ROW] })
  if (parsed === null) throw new Error("expected the well-formed payload to parse")

  const [artifact]: ReadonlyArray<CapturedArtifact> = parsed
  expect(artifact).toEqual({
    id: "cap-1",
    path: "/work/acme/docs/notes.md",
    relativePath: "docs/notes.md",
    mimeType: "text/markdown",
    isBinary: false,
    changeKind: "edited",
    diff: "@@ -1 +1 @@\n-old\n+new\n",
    oldFragment: null,
    editCount: 2,
    firstSeenAt: "2026-07-01T10:00:00.000Z",
    lastSeenAt: "2026-07-01T10:05:00.000Z",
  })
})

test("S48: the list route omitting diff and oldFragment yields nulls rather than a parse failure", () => {
  const { diff: _diff, oldFragment: _oldFragment, ...withoutBodies } = ROW
  const parsed = parseSessionArtifacts({ artifacts: [withoutBodies] })
  if (parsed === null) throw new Error("expected a summary row to parse")
  expect(parsed[0]?.diff).toBeNull()
  expect(parsed[0]?.oldFragment).toBeNull()
})

test("S54: a row missing a required field is rejected, so no partially-typed artifact reaches the view", () => {
  for (const field of ["id", "relativePath", "mimeType", "changeKind", "lastSeenAt"]) {
    const { [field]: _dropped, ...broken } = ROW as Record<string, unknown>
    expect(parseSessionArtifacts({ artifacts: [broken] })).toBeNull()
  }
  expect(parseSessionArtifacts({ artifacts: [{ ...ROW, relativePath: 42 }] })).toBeNull()
  expect(parseSessionArtifacts({ notArtifacts: [] })).toBeNull()
  expect(parseSessionArtifacts(null)).toBeNull()
})

test("session list parsing requires its pagination and authorization-safe vocabulary", () => {
  const parsed = parseSessionList(listPayload)
  expect(parsed?.pagination.total).toBe(1)
  expect(parsed?.filterOptions.branches).toEqual(["main"])
  expect(parsed?.sessions[0]?.match?.sourceKind).toBe("toolResult")

  expect(
    parseSessionList({ ...listPayload, pagination: { ...listPayload.pagination, totalPages: 2 } }),
  ).toBeNull()
  expect(
    parseSessionList({
      ...listPayload,
      filterOptions: { ...listPayload.filterOptions, branches: [42] },
    }),
  ).toBeNull()
})

test("accepts a truthful out-of-range page with an empty session list", () => {
  expect(
    parseSessionList({
      ...listPayload,
      sessions: [],
      pagination: { page: 9, limit: 25, total: 1, totalPages: 1 },
    }),
  ).toMatchObject({ pagination: { page: 9, total: 1, totalPages: 1 }, sessions: [] })
})

test("malformed decorative match evidence is dropped rather than poisoning a valid session list", () => {
  const parsed = parseSessionList({
    ...listPayload,
    sessions: [{ ...session, match: { sourceKind: "artifact", sourceRowId: "a", snippet: [] } }],
  })
  expect(parsed?.sessions[0]?.match).toBeNull()
})

const SYNC_STATUS_ROW = {
  userId: "u-1",
  githubLogin: "maya",
  name: "Maya",
  avatarUrl: "https://example.com/maya.png",
  projectId: "p-1",
  projectName: "Samskara",
  projectSlug: "samskara",
  sessionCount: 3,
  lastSyncedAt: "2026-08-20T10:00:00.000Z",
}

test("S1: a row missing a field is rejected by the parser, and a well-formed body returns an array of the same length", () => {
  const { lastSyncedAt: _dropped, ...broken } = SYNC_STATUS_ROW
  expect(parseSyncStatusRows({ rows: [broken] })).toBeNull()

  // parseSyncStatusRow checks required fields in two separate guards; a row missing a field from
  // either one must be rejected, not just the second guard covered above.
  const { userId: _droppedUserId, ...missingUserId } = SYNC_STATUS_ROW
  expect(parseSyncStatusRows({ rows: [missingUserId] })).toBeNull()

  const { githubLogin: _droppedLogin, ...missingLogin } = SYNC_STATUS_ROW
  expect(parseSyncStatusRows({ rows: [missingLogin] })).toBeNull()

  const parsed = parseSyncStatusRows({ rows: [SYNC_STATUS_ROW, SYNC_STATUS_ROW] })
  expect(parsed).toHaveLength(2)
})
