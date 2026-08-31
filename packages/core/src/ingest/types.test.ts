import { expect, test } from "vitest"
import {
  artifactUploadSchema,
  createProjectRequestSchema,
  createProjectResponseSchema,
  ingestPayloadSchema,
  type ParsedRecord,
  projectIdentitySchema,
  reassignSessionsRequestSchema,
  reassignSessionsResponseSchema,
} from "./types.js"

const records: ReadonlyArray<ParsedRecord> = [
  {
    lineUuid: "0191d942-3ba5-7dba-9a7d-22d65b30258c",
    lineNumber: 1,
    raw: {},
    messages: [
      {
        subIndex: 0,
        sessionId: "sess-1",
        source: "claude_code",
        sourceSchemaVersion: 1,
        trackId: "main",
        msgType: "custom",
        subType: "fixture",
      },
    ],
  },
]

const base = {
  sessionId: "sess-1",
  source: "claude_code" as const,
  project: { name: "widget", slug: "acme-widget" },
  sourceRelativePath: "sess-1.jsonl",
  records,
} as const

test("S15: a payload whose project omits root still validates", () => {
  const parsed = ingestPayloadSchema.safeParse({ ...base, type: "main" })

  expect(parsed.success).toBe(true)
  expect(parsed.success && parsed.data.project.root).toBeUndefined()
})

test("S15: a payload whose project carries a root validates and preserves it", () => {
  const parsed = ingestPayloadSchema.safeParse({
    ...base,
    type: "main",
    project: { ...base.project, root: "/work/app" },
  })

  expect(parsed.success).toBe(true)
  expect(parsed.success && parsed.data.project.root).toBe("/work/app")
})

// The schema is strict and sits in the ingest wire payload, so an unknown key must still be
// rejected -- adding `root` widened the shape by exactly one optional field, nothing more.
test("S15: the strict project schema still rejects an unknown key", () => {
  expect(projectIdentitySchema.safeParse({ name: "w", slug: "a-w", branch: "main" }).success).toBe(
    false,
  )
})

test("S15: the project schema rejects an empty root rather than storing a meaningless path", () => {
  expect(projectIdentitySchema.safeParse({ name: "w", slug: "a-w", root: "" }).success).toBe(false)
})

test("the project schema accepts an optional projectId and remote, preserving both", () => {
  const parsed = projectIdentitySchema.safeParse({
    name: "w",
    slug: "a-w",
    projectId: "0191d942-3ba5-7dba-9a7d-22d65b30258c",
    remote: { host: "github.com", owner: "acme", repoName: "widget" },
  })

  expect(parsed.success).toBe(true)
  expect(parsed.success && parsed.data.projectId).toBe("0191d942-3ba5-7dba-9a7d-22d65b30258c")
  expect(parsed.success && parsed.data.remote).toEqual({
    host: "github.com",
    owner: "acme",
    repoName: "widget",
  })
})

test("the project schema rejects a projectId that is not a UUID", () => {
  expect(
    projectIdentitySchema.safeParse({ name: "w", slug: "a-w", projectId: "not-a-uuid" }).success,
  ).toBe(false)
})

test("createProjectRequestSchema accepts a body with or without remote and rejects an unknown key", () => {
  expect(
    createProjectRequestSchema.safeParse({ name: "widget", slug: "acme-widget" }).success,
  ).toBe(true)
  expect(
    createProjectRequestSchema.safeParse({
      name: "widget",
      slug: "acme-widget",
      remote: { host: "github.com", owner: "acme", repoName: "widget" },
    }).success,
  ).toBe(true)
  expect(
    createProjectRequestSchema.safeParse({ name: "widget", slug: "acme-widget", root: "/work" })
      .success,
  ).toBe(false)
})

test("createProjectResponseSchema accepts an org owner with no reason and a user owner with notMember", () => {
  const org = createProjectResponseSchema.safeParse({
    id: "0191d942-3ba5-7dba-9a7d-22d65b30258c",
    owner: { type: "org", slug: "acme" },
  })
  const userWithReason = createProjectResponseSchema.safeParse({
    id: "0191d942-3ba5-7dba-9a7d-22d65b30258c",
    owner: { type: "user", slug: "maya" },
    reason: "notMember",
  })

  expect(org.success).toBe(true)
  expect(userWithReason.success).toBe(true)
  expect(
    createProjectResponseSchema.safeParse({
      id: "0191d942-3ba5-7dba-9a7d-22d65b30258c",
      owner: { type: "team", slug: "acme" },
    }).success,
  ).toBe(false)
})

test("a pull request git event carries its own repo on the ingest wire, and the union still admits commits", () => {
  const parsed = ingestPayloadSchema.safeParse({
    ...base,
    type: "main",
    gitEvents: [
      {
        kind: "pullRequest",
        host: "github.com",
        owner: "refrens",
        repoName: "birds",
        number: 391,
        callId: "call-pr",
      },
      { kind: "commit", sha: "37f3101", callId: "call-commit" },
    ],
  })

  expect(parsed.success).toBe(true)
  expect(parsed.success && parsed.data.gitEvents?.map((event) => event.kind)).toEqual([
    "pullRequest",
    "commit",
  ])
})

const uploadBase = {
  sessionId: "sess-1",
  path: "/work/app/docs/notes.md",
  relativePath: "docs/notes.md",
  mimeType: "text/markdown",
  changeKind: "editedUnknownBase" as const,
  encoding: "utf8" as const,
  currentContent: "hi",
  currentHash: "hash",
  observedAt: "2026-07-28T12:00:00.000Z",
}

test("a pull request event with a non-positive number is rejected at the wire boundary", () => {
  const withNumber = (number: number) =>
    ingestPayloadSchema.safeParse({
      ...base,
      type: "main",
      gitEvents: [
        {
          kind: "pullRequest",
          host: "github.com",
          owner: "refrens",
          repoName: "birds",
          number,
          callId: "call-pr",
        },
      ],
    }).success

  expect(withNumber(391)).toBe(true)
  expect(withNumber(0)).toBe(false)
  expect(withNumber(-1)).toBe(false)
})

test("an artifact upload validates with an optional base, and nothing else rides along", () => {
  expect(artifactUploadSchema.safeParse(uploadBase).success).toBe(true)
  expect(
    artifactUploadSchema.safeParse({
      ...uploadBase,
      changeKind: "edited",
      baseContent: "original\n",
    }).success,
  ).toBe(true)
})

test("the strict upload schema refuses a diff, an excerpt or an edit list the server no longer stores", () => {
  for (const extra of [
    { diff: "--- a\n+++ b\n" },
    { oldFragment: "the replaced text" },
    { edits: [{ callId: "call-1", seq: 10, hunks: [] }] },
  ]) {
    expect(artifactUploadSchema.safeParse({ ...uploadBase, ...extra }).success).toBe(false)
  }
})

test("a reassign request defaults to the caller's own sessions, so an omitted scope never moves a teammate's history", () => {
  const parsed = reassignSessionsRequestSchema.safeParse({
    fromProjectId: "0191d942-3ba5-7dba-9a7d-22d65b30258c",
  })
  expect(parsed.success && parsed.data.scope).toBe("mine")
})

test("a reassign request keeps an explicit scope and rejects one it does not know", () => {
  const from = "0191d942-3ba5-7dba-9a7d-22d65b30258c"
  const all = reassignSessionsRequestSchema.safeParse({ fromProjectId: from, scope: "all" })
  expect(all.success && all.data.scope).toBe("all")
  expect(
    reassignSessionsRequestSchema.safeParse({ fromProjectId: from, scope: "some" }).success,
  ).toBe(false)
})

test("a reassign request refuses a source that is not a uuid, and refuses fields riding along", () => {
  expect(reassignSessionsRequestSchema.safeParse({ fromProjectId: "project-one" }).success).toBe(
    false,
  )
  expect(
    reassignSessionsRequestSchema.safeParse({
      fromProjectId: "0191d942-3ba5-7dba-9a7d-22d65b30258c",
      toProjectId: "0191d942-3ba5-7dba-9a7d-22d65b30258c",
    }).success,
  ).toBe(false)
})

test("a reassign response carries a whole non-negative count, never a fraction or a negative", () => {
  expect(reassignSessionsResponseSchema.safeParse({ moved: 0 }).success).toBe(true)
  expect(reassignSessionsResponseSchema.safeParse({ moved: 12 }).success).toBe(true)
  expect(reassignSessionsResponseSchema.safeParse({ moved: -1 }).success).toBe(false)
  expect(reassignSessionsResponseSchema.safeParse({ moved: 1.5 }).success).toBe(false)
})
