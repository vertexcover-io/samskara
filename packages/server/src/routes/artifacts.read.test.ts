import { createHash } from "node:crypto"
import { createLogger } from "@samskara/core"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest"
import { buildApp } from "../app.js"
import type { Db } from "../db/client.js"
import {
  artifact,
  orgs,
  projects,
  sessions,
  userOrgs,
  userProjectGrant,
  users,
} from "../db/schema.js"
import { dockerAvailable, startTestDb } from "../db/testDb.js"
import type { Env } from "../lib/env.js"
import { signToken } from "../lib/jwt.js"
import * as projectsRepo from "../repositories/projects.repo.js"
import { rangeResponse } from "./artifacts.js"

// Pure-function boundary cases for `rangeResponse` -- no Postgres/HTTP needed, so these run
// unconditionally even without Docker, unlike the route suite below.
describe("rangeResponse", () => {
  const serve = { contentType: "application/octet-stream", disposition: "attachment" as const }
  const bytes = Buffer.from("0123456789") // length 10, valid indices 0-9

  test.each([
    ["a suffix range returns the final N bytes", "bytes=-3", "789", "bytes 7-9/10"],
    [
      "a suffix range longer than the file clamps to the whole file, not a negative start",
      "bytes=-1000",
      "0123456789",
      "bytes 0-9/10",
    ],
    [
      "start one before the byte length is the final single byte",
      "bytes=9-15",
      "9",
      "bytes 9-9/10",
    ],
    [
      "an open-ended range from a middle offset runs to the last byte",
      "bytes=5-",
      "56789",
      "bytes 5-9/10",
    ],
  ])("%s", (_name, range, body, contentRange) => {
    const result = rangeResponse(bytes, serve, range)
    if (result.kind !== "partial") throw new Error(`expected partial, got ${result.kind}`)
    expect(result.body.toString()).toBe(body)
    expect(result.headers["content-range"]).toBe(contentRange)
    expect(result.headers["content-length"]).toBe(String(body.length))
  })

  test("start exactly at the byte length is unsatisfiable", () => {
    const result = rangeResponse(bytes, serve, "bytes=10-15")
    expect(result.kind).toBe("unsatisfiable")
    expect(result.headers["content-range"]).toBe("bytes */10")
  })

  test.each([
    ["a bare 'bytes=-' with no digits either side", "bytes=-"],
    ["a malformed range header", "not-a-range"],
  ])("%s falls back to a full response rather than erroring", (_name, range) => {
    const result = rangeResponse(bytes, serve, range)
    if (result.kind !== "full") throw new Error(`expected full, got ${result.kind}`)
    expect(result.body.equals(bytes)).toBe(true)
  })

  test("no range header at all returns the full body with content-length", () => {
    const result = rangeResponse(bytes, serve, undefined)
    expect(result.kind).toBe("full")
    expect(result.headers["content-length"]).toBe("10")
  })
})

const env: Env = {
  githubClientId: "id",
  githubClientSecret: "secret",
  publicBaseUrl: "http://localhost:3000",
  webBaseUrl: "http://localhost:8000",
  cookieSecure: false,
  jwtSecret: "test-secret-value",
  jwtExpiresIn: "7d",
  superAdminLogins: [],
  aiReviewHarness: "opencode",
  aiReviewModel: "zai-coding-plan/glm-5.3-flash",
  aiReviewTimeoutMs: 600_000,
}

const sha256 = (content: Buffer): string => createHash("sha256").update(content).digest("hex")

const SESSION_ID = "artifact-read-session"
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(24, 0x41),
])

type SeedArtifact = {
  readonly path: string
  readonly relativePath?: string
  readonly mimeType: string
  readonly isBinary: boolean
  readonly changeKind?: string
  readonly current: Buffer
  readonly base?: Buffer
  readonly diff?: string
  readonly sessionId?: string
}

describe.skipIf(!dockerAvailable())("artifact read routes", () => {
  let teardown: () => Promise<void>
  let db: Db
  let app: ReturnType<typeof buildApp>
  let ownerToken: string
  let cliToken: string
  let viewerToken: string
  let strangerToken: string

  const get = (path: string, token: string, headers: Record<string, string> = {}) =>
    app.request(path, { headers: { authorization: `Bearer ${token}`, ...headers } })

  const seedArtifact = async (input: SeedArtifact): Promise<string> => {
    const [row] = await db
      .insert(artifact)
      .values({
        sessionId: input.sessionId ?? SESSION_ID,
        path: input.path,
        relativePath: input.relativePath ?? input.path.replace(/^\//, ""),
        mimeType: input.mimeType,
        isBinary: input.isBinary,
        changeKind: input.changeKind ?? (input.base === undefined ? "created" : "edited"),
        currentContent: input.current,
        currentHash: sha256(input.current),
        baseContent: input.base ?? null,
        diff: input.diff ?? null,
      })
      .returning({ id: artifact.id })
    if (!row) throw new Error("seed artifact failed")
    return row.id
  }

  beforeAll(async () => {
    const started = await startTestDb()
    db = started.db

    const seedUser = async (githubId: number, login: string): Promise<string> => {
      const [row] = await db.insert(users).values({ githubId, githubLogin: login }).returning()
      if (!row) throw new Error(`seed user ${login} failed`)
      return row.id
    }

    const ownerId = await seedUser(7101, "artifact-owner")
    const viewerId = await seedUser(7102, "artifact-viewer")
    const strangerId = await seedUser(7103, "artifact-stranger")

    const [project] = await db
      .insert(projects)
      .values({ name: "read-widget", slug: "artifact-read-widget", ownerUserId: ownerId })
      .returning()
    if (!project) throw new Error("seed project failed")

    await db
      .insert(userProjectGrant)
      .values({ userId: viewerId, projectId: project.id, scope: "viewer" })

    await db
      .insert(sessions)
      .values({ id: SESSION_ID, source: "claude_code", userId: ownerId, projectId: project.id })

    ownerToken = await signToken(env, { sub: ownerId, aud: "web" })
    cliToken = await signToken(env, { sub: ownerId, aud: "cli" })
    viewerToken = await signToken(env, { sub: viewerId, aud: "web" })
    strangerToken = await signToken(env, { sub: strangerId, aud: "web" })

    app = buildApp(db, env, { rootLog: createLogger({ service: "test" }, { level: "silent" }) })
    teardown = started.teardown
  }, 180_000)

  afterAll(async () => {
    await teardown?.()
  })

  beforeEach(async () => {
    await db.delete(artifact)
  })

  test("S39: a session's artifacts are listed with metadata and diff, and never with their blobs", async () => {
    await seedArtifact({
      path: "/work/docs/notes.md",
      relativePath: "docs/notes.md",
      mimeType: "text/markdown",
      isBinary: false,
      current: Buffer.from("# Notes\n\nChanged.\n", "utf8"),
      base: Buffer.from("# Notes\n\nOriginal.\n", "utf8"),
      diff: "--- a\n+++ b\n-Original.\n+Changed.\n",
    })
    await seedArtifact({
      path: "/work/assets/shot.png",
      relativePath: "assets/shot.png",
      mimeType: "image/png",
      isBinary: true,
      current: PNG_BYTES,
    })

    const res = await get(`/api/sessions/${SESSION_ID}/artifacts`, ownerToken)
    expect(res.status).toBe(200)

    const { artifacts } = (await res.json()) as {
      artifacts: ReadonlyArray<Record<string, unknown>>
    }
    expect(artifacts).toHaveLength(2)

    const byPath = new Map(artifacts.map((row) => [row.relativePath, row]))
    const text = byPath.get("docs/notes.md")
    const binary = byPath.get("assets/shot.png")

    expect(text).toMatchObject({
      path: "/work/docs/notes.md",
      mimeType: "text/markdown",
      isBinary: false,
      changeKind: "edited",
      editCount: 1,
      byteSize: Buffer.byteLength("# Notes\n\nChanged.\n"),
      diff: "--- a\n+++ b\n-Original.\n+Changed.\n",
    })
    expect(binary).toMatchObject({ isBinary: true, byteSize: PNG_BYTES.length })

    // The whole point of the list shape: a list view must not drag every artifact's bytes with it.
    for (const row of artifacts) {
      expect(row).not.toHaveProperty("currentContent")
      expect(row).not.toHaveProperty("baseContent")
    }
  })

  test("S40: a single text artifact reads back with its diff and both contents byte for byte", async () => {
    const current = "# Notes\n\nChanged.\n"
    const base = "# Notes\n\nOriginal.\n"
    const id = await seedArtifact({
      path: "/work/docs/notes.md",
      relativePath: "docs/notes.md",
      mimeType: "text/markdown",
      isBinary: false,
      current: Buffer.from(current, "utf8"),
      base: Buffer.from(base, "utf8"),
      diff: "--- a\n+++ b\n-Original.\n+Changed.\n",
    })

    const res = await get(`/api/artifacts/${id}`, ownerToken)
    expect(res.status).toBe(200)

    const body = (await res.json()) as { artifact: Record<string, unknown> }
    expect(body.artifact).toMatchObject({
      id,
      relativePath: "docs/notes.md",
      currentContent: current,
      baseContent: base,
      diff: "--- a\n+++ b\n-Original.\n+Changed.\n",
    })
    expect(new Date(String(body.artifact.lastSeenAt)).toISOString()).toBe(body.artifact.lastSeenAt)
  })

  test("S40: a binary artifact carries its metadata and omits its contents", async () => {
    const id = await seedArtifact({
      path: "/work/assets/shot.png",
      relativePath: "assets/shot.png",
      mimeType: "image/png",
      isBinary: true,
      current: PNG_BYTES,
    })

    const res = await get(`/api/artifacts/${id}`, ownerToken)
    expect(res.status).toBe(200)

    const body = (await res.json()) as { artifact: Record<string, unknown> }
    expect(body.artifact).toMatchObject({
      isBinary: true,
      currentContent: null,
      baseContent: null,
      byteSize: PNG_BYTES.length,
    })
  })

  test("S41: a user without access is refused on every read route, indistinguishably from absent", async () => {
    const id = await seedArtifact({
      path: "/work/docs/secret.md",
      relativePath: "docs/secret.md",
      mimeType: "text/markdown",
      isBinary: false,
      current: Buffer.from("classified\n", "utf8"),
    })

    const list = await get(`/api/sessions/${SESSION_ID}/artifacts`, strangerToken)
    const detail = await get(`/api/artifacts/${id}`, strangerToken)
    const raw = await get(`/api/artifacts/${id}/raw`, strangerToken)

    expect(list.status).toBe(404)
    expect(detail.status).toBe(404)
    expect(raw.status).toBe(404)

    const hiddenDetailBody = await detail.json()
    const hiddenRawBody = await raw.json()

    // The refusal must not distinguish "not yours" from "does not exist": a different status or
    // body for a real-but-invisible row is an existence oracle. A malformed id -- one Postgres
    // cannot even cast to uuid -- must answer identically rather than raising a 500.
    const absentId = "00000000-0000-0000-0000-0000000000ff"
    for (const id of [absentId, "not-a-uuid"]) {
      const absentDetail = await get(`/api/artifacts/${id}`, strangerToken)
      const absentRaw = await get(`/api/artifacts/${id}/raw`, strangerToken)
      expect(absentDetail.status).toBe(detail.status)
      expect(await absentDetail.json()).toEqual(hiddenDetailBody)
      expect(absentRaw.status).toBe(raw.status)
      expect(await absentRaw.json()).toEqual(hiddenRawBody)
    }
  })

  test("S41: the project owner and a viewer-grant holder both read the same artifact", async () => {
    const id = await seedArtifact({
      path: "/work/docs/shared.md",
      relativePath: "docs/shared.md",
      mimeType: "text/markdown",
      isBinary: false,
      current: Buffer.from("shared content\n", "utf8"),
    })

    for (const token of [ownerToken, viewerToken]) {
      expect((await get(`/api/sessions/${SESSION_ID}/artifacts`, token)).status).toBe(200)
      expect((await get(`/api/artifacts/${id}`, token)).status).toBe(200)
      expect((await get(`/api/artifacts/${id}/raw`, token)).status).toBe(200)
    }
  })

  test("S42: a claimed application/javascript type is never echoed -- text serves as text/plain", async () => {
    const id = await seedArtifact({
      path: "/work/evil.js",
      relativePath: "evil.js",
      mimeType: "application/javascript",
      isBinary: false,
      current: Buffer.from("alert(document.cookie)\n", "utf8"),
    })

    const res = await get(`/api/artifacts/${id}/raw`, ownerToken)
    expect(res.status).toBe(200)

    const contentType = res.headers.get("content-type") ?? ""
    expect(contentType).toBe("text/plain; charset=utf-8")
    // Any casing: a `<script src>` load only needs the browser to accept the type.
    expect(contentType.toLowerCase()).not.toContain("javascript")
    expect(res.headers.get("x-content-type-options")).toBe("nosniff")
    expect(res.headers.get("content-disposition")).toBe("attachment")
    expect(await res.text()).toBe("alert(document.cookie)\n")
  })

  test("S46: a range request on a binary artifact returns the requested slice as a 206", async () => {
    const id = await seedArtifact({
      path: "/work/clip.mp4",
      relativePath: "clip.mp4",
      mimeType: "video/mp4",
      isBinary: true,
      current: PNG_BYTES,
    })

    const res = await get(`/api/artifacts/${id}/raw`, ownerToken, { range: "bytes=0-9" })
    expect(res.status).toBe(206)
    expect(res.headers.get("accept-ranges")).toBe("bytes")
    expect(res.headers.get("content-range")).toBe(`bytes 0-9/${PNG_BYTES.length}`)

    const body = Buffer.from(await res.arrayBuffer())
    expect(body).toHaveLength(10)
    expect(body.equals(PNG_BYTES.subarray(0, 10))).toBe(true)
  })

  test("S46: a range starting beyond the artifact's length is a 416", async () => {
    const id = await seedArtifact({
      path: "/work/clip2.mp4",
      relativePath: "clip2.mp4",
      mimeType: "video/mp4",
      isBinary: true,
      current: PNG_BYTES,
    })

    const res = await get(`/api/artifacts/${id}/raw`, ownerToken, {
      range: `bytes=${PNG_BYTES.length + 10}-${PNG_BYTES.length + 20}`,
    })
    expect(res.status).toBe(416)
    expect(res.headers.get("content-range")).toBe(`bytes */${PNG_BYTES.length}`)
  })

  test("S47: requesting a base an artifact never had is a 404, while current returns its bytes", async () => {
    const id = await seedArtifact({
      path: "/work/created.md",
      relativePath: "created.md",
      mimeType: "text/markdown",
      isBinary: false,
      changeKind: "created",
      current: Buffer.from("brand new\n", "utf8"),
    })

    const base = await get(`/api/artifacts/${id}/raw?which=base`, ownerToken)
    expect(base.status).toBe(404)
    expect(await base.json()).toEqual({ error: "artifactNotFound" })

    const current = await get(`/api/artifacts/${id}/raw?which=current`, ownerToken)
    expect(current.status).toBe(200)
    expect(await current.text()).toBe("brand new\n")
  })

  test("S47: which=base returns the stored base when one exists, and defaults to current when omitted", async () => {
    const id = await seedArtifact({
      path: "/work/edited.md",
      relativePath: "edited.md",
      mimeType: "text/markdown",
      isBinary: false,
      current: Buffer.from("after\n", "utf8"),
      base: Buffer.from("before\n", "utf8"),
    })

    expect(await (await get(`/api/artifacts/${id}/raw?which=base`, ownerToken)).text()).toBe(
      "before\n",
    )
    expect(await (await get(`/api/artifacts/${id}/raw`, ownerToken)).text()).toBe("after\n")
  })

  test("S41: a CLI-audience token is 401 on the session artifact list, the detail and the raw route, and so is an unauthenticated caller", async () => {
    const id = await seedArtifact({
      path: "/work/docs/auth.md",
      relativePath: "docs/auth.md",
      mimeType: "text/markdown",
      isBinary: false,
      current: Buffer.from("content\n", "utf8"),
    })

    const cliList = await get(`/api/sessions/${SESSION_ID}/artifacts`, cliToken)
    expect(cliList.status).toBe(401)
    expect(await cliList.json()).toEqual({ error: "unauthorized" })
    expect((await get(`/api/artifacts/${id}`, cliToken)).status).toBe(401)
    expect((await get(`/api/artifacts/${id}/raw`, cliToken)).status).toBe(401)
    expect((await app.request(`/api/artifacts/${id}`)).status).toBe(401)
  })

  test("SC2: a member of the owning org reads an org project's artifact; a non-member is refused", async () => {
    const seedUser = async (githubId: number, login: string): Promise<string> => {
      const [row] = await db.insert(users).values({ githubId, githubLogin: login }).returning()
      if (!row) throw new Error(`seed user ${login} failed`)
      return row.id
    }
    const member = await seedUser(7201, "artifact-org-member")
    const outsider = await seedUser(7202, "artifact-org-outsider")
    const [org] = await db
      .insert(orgs)
      .values({ githubSlug: "artifact-acme", name: "Acme" })
      .returning({ id: orgs.id })
    if (!org) throw new Error("seed org failed")
    await db.insert(userOrgs).values({ userId: member, orgId: org.id })

    const { id: orgProjectId } = await projectsRepo.upsertOwned(db, {
      identity: { name: "acme-widget", slug: "artifact-acme-widget" },
      owner: { kind: "org", orgId: org.id },
    })
    const orgSessionId = "artifact-org-session"
    await db
      .insert(sessions)
      .values({ id: orgSessionId, source: "claude_code", userId: member, projectId: orgProjectId })

    const id = await seedArtifact({
      sessionId: orgSessionId,
      path: "/work/docs/org.md",
      relativePath: "docs/org.md",
      mimeType: "text/markdown",
      isBinary: false,
      current: Buffer.from("org content\n", "utf8"),
    })

    const memberToken = await signToken(env, { sub: member, aud: "web" })
    const outsiderToken = await signToken(env, { sub: outsider, aud: "web" })

    expect((await get(`/api/sessions/${orgSessionId}/artifacts`, memberToken)).status).toBe(200)
    expect((await get(`/api/artifacts/${id}`, memberToken)).status).toBe(200)

    expect((await get(`/api/sessions/${orgSessionId}/artifacts`, outsiderToken)).status).toBe(404)
    expect((await get(`/api/artifacts/${id}`, outsiderToken)).status).toBe(404)
  })
})
