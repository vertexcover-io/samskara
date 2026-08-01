import { expect, test } from "vitest"
import { parseSessionArtifacts, parseSessionList, parseSessionSearchChunks } from "./parse.js"
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

const SESSION_ROW = {
  id: "s-1",
  title: "Port the session detail surface",
  projectName: "Samskara",
  projectSlug: "samskara",
  userLogin: "maya",
  model: "claude-opus-5",
  durationMs: 3_723_000,
  tokensTotal: 128_400,
  status: "complete",
  lastActiveAt: "2026-02-01T09:30:00.000Z",
}

test("D19: a session row with no snippet key (the plain, unfiltered list route) parses with snippet null, not a failure", () => {
  const parsed = parseSessionList({ sessions: [SESSION_ROW] })
  if (parsed === null) throw new Error("expected a plain session row to parse")

  expect(parsed[0]?.snippet).toBeNull()
  expect(parsed[0]?.anchorMessageId).toBeNull()
})

test("D19: a session row carrying a snippet (a `?q=` response) parses it through", () => {
  const parsed = parseSessionList({
    sessions: [{ ...SESSION_ROW, score: 0.42, snippet: "investigate the memory leak" }],
  })
  if (parsed === null) throw new Error("expected a ranked session row to parse")

  expect(parsed[0]?.snippet).toBe("investigate the memory leak")
})

test("D22: a ranked session row carries the winning chunk's anchor", () => {
  const parsed = parseSessionList({
    sessions: [
      {
        ...SESSION_ROW,
        score: 0.42,
        snippet: "investigate the memory leak",
        anchorMessageId: "m-9",
      },
    ],
  })
  if (parsed === null) throw new Error("expected a ranked session row to parse")

  expect(parsed[0]?.anchorMessageId).toBe("m-9")
})

test("D1: a well-formed `/:id/search` response parses into ranked chunks", () => {
  const parsed = parseSessionSearchChunks({
    chunks: [
      { anchorMessageId: "m-1", snippet: "the login timeout keeps happening", score: 0.031 },
      { anchorMessageId: null, snippet: "Outage investigation", score: 0.02 },
    ],
  })
  if (parsed === null) throw new Error("expected a well-formed chunks response to parse")

  expect(parsed).toEqual([
    { anchorMessageId: "m-1", snippet: "the login timeout keeps happening", score: 0.031 },
    { anchorMessageId: null, snippet: "Outage investigation", score: 0.02 },
  ])
})

test("D1: a chunks response missing a required field is rejected, so no partially-typed chunk reaches the view", () => {
  expect(parseSessionSearchChunks({ chunks: [{ anchorMessageId: "m-1", score: 0.03 }] })).toBeNull()
  expect(
    parseSessionSearchChunks({ chunks: [{ anchorMessageId: "m-1", snippet: "hi" }] }),
  ).toBeNull()
  expect(parseSessionSearchChunks({ notChunks: [] })).toBeNull()
  expect(parseSessionSearchChunks(null)).toBeNull()
})
