import { expect, test } from "vitest"
import {
  createProjectRequestSchema,
  createProjectResponseSchema,
  ingestPayloadSchema,
  type ParsedRecord,
  projectIdentitySchema,
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

// A PR number is the other half of its identity, so a zero or a negative must not reach the DB.
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
