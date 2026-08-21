import { expect, test } from "vitest"
import { parseSessionArtifacts } from "./parse.js"
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
