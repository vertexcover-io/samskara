import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import { createLogger } from "@samskara/core"
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest"
import { buildApp } from "../app.js"
import { type Db, createDb } from "../db/client.js"
import { artifact, projects, sessions, userProjectGrant, users } from "../db/schema.js"
import type { Env } from "../lib/env.js"
import { signToken } from "../lib/jwt.js"
import { __testOnlyRangeResponse } from "./artifacts.js"

// Pure-function boundary cases for `rangeResponse` -- no Postgres/HTTP needed, so these run
// unconditionally even without Docker, unlike the route suite below.
describe("rangeResponse", () => {
  const serve = { contentType: "application/octet-stream", disposition: "attachment" as const }
  const bytes = Buffer.from("0123456789") // length 10, valid indices 0-9

  test("a suffix range returns the final N bytes", () => {
    const result = __testOnlyRangeResponse(bytes, serve, "bytes=-3")
    if (result.kind !== "partial") throw new Error(`expected partial, got ${result.kind}`)
    expect(result.body.toString()).toBe("789")
    expect(result.headers["content-range"]).toBe("bytes 7-9/10")
    expect(result.headers["content-length"]).toBe("3")
  })

  test("a suffix range longer than the file clamps to the whole file, not a negative start", () => {
    const result = __testOnlyRangeResponse(bytes, serve, "bytes=-1000")
    if (result.kind !== "partial") throw new Error(`expected partial, got ${result.kind}`)
    expect(result.body.toString()).toBe("0123456789")
    expect(result.headers["content-range"]).toBe("bytes 0-9/10")
  })

  test("start exactly at the byte length is unsatisfiable", () => {
    const result = __testOnlyRangeResponse(bytes, serve, "bytes=10-15")
    expect(result.kind).toBe("unsatisfiable")
    expect(result.headers["content-range"]).toBe("bytes */10")
  })

  test("start one before the byte length is the final single byte", () => {
    const result = __testOnlyRangeResponse(bytes, serve, "bytes=9-15")
    if (result.kind !== "partial") throw new Error(`expected partial, got ${result.kind}`)
    expect(result.body.toString()).toBe("9")
    expect(result.headers["content-range"]).toBe("bytes 9-9/10")
  })

  test("a bare 'bytes=-' with no digits either side falls back to a full response", () => {
    const result = __testOnlyRangeResponse(bytes, serve, "bytes=-")
    if (result.kind !== "full") throw new Error(`expected full, got ${result.kind}`)
    expect(result.body.equals(bytes)).toBe(true)
  })

  test("a malformed range header falls back to a full response rather than erroring", () => {
    const result = __testOnlyRangeResponse(bytes, serve, "not-a-range")
    if (result.kind !== "full") throw new Error(`expected full, got ${result.kind}`)
    expect(result.body.equals(bytes)).toBe(true)
  })

  test("no range header at all returns the full body with content-length", () => {
    const result = __testOnlyRangeResponse(bytes, serve, undefined)
    expect(result.kind).toBe("full")
    expect(result.headers["content-length"]).toBe("10")
  })

  test("an open-ended range from a middle offset runs to the last byte", () => {
    const result = __testOnlyRangeResponse(bytes, serve, "bytes=5-")
    if (result.kind !== "partial") throw new Error(`expected partial, got ${result.kind}`)
    expect(result.body.toString()).toBe("56789")
    expect(result.headers["content-range"]).toBe("bytes 5-9/10")
  })
})

const dockerAvailable = () => {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

const packageDir = fileURLToPath(new URL("../..", import.meta.url))

const env: Env = {
  githubClientId: "id",
  githubClientSecret: "secret",
  publicBaseUrl: "http://localhost:3000",
  webBaseUrl: "http://localhost:8000",
  cookieSecure: false,
  jwtSecret: "test-secret-value",
  jwtExpiresIn: "7d",
}

const sha256 = (content: Buffer): string => createHash("sha256").update(content).digest("hex")

const SESSION_ID = "artifact-read-session"
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(24, 0x41),
])
const HTML = "<!doctype html><html><body><script>alert('xss')</script></body></html>"
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'

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
  let container: StartedPostgreSqlContainer
  let teardown: () => Promise<void>
  let db: Db
  let app: ReturnType<typeof buildApp>
  let ownerToken: string
  let viewerToken: string
  let strangerToken: string
  let foreignSessionId: string

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
        baseHash: input.base === undefined ? null : sha256(input.base),
        diff: input.diff ?? null,
      })
      .returning({ id: artifact.id })
    if (!row) throw new Error("seed artifact failed")
    return row.id
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start()
    const url = container.getConnectionUri()
    execFileSync("bun", ["run", "db:migrate"], {
      cwd: packageDir,
      env: { ...process.env, DATABASE_URL: url },
      stdio: "inherit",
    })
    const created = createDb(url)
    db = created.db

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
      .values({ name: "read-widget", slug: "artifact-read-widget", ownerId })
      .returning()
    if (!project) throw new Error("seed project failed")

    // A project the stranger owns outright, so the "refused" assertions cannot be satisfied by a
    // route that simply refuses every caller.
    const [foreignProject] = await db
      .insert(projects)
      .values({ name: "foreign", slug: "artifact-foreign", ownerId: strangerId })
      .returning()
    if (!foreignProject) throw new Error("seed foreign project failed")

    await db
      .insert(userProjectGrant)
      .values({ userId: viewerId, projectId: project.id, scope: "viewer" })

    await db
      .insert(sessions)
      .values({ id: SESSION_ID, source: "claude_code", userId: ownerId, projectId: project.id })

    foreignSessionId = "artifact-read-foreign-session"
    await db.insert(sessions).values({
      id: foreignSessionId,
      source: "claude_code",
      userId: strangerId,
      projectId: foreignProject.id,
    })

    ownerToken = await signToken(env, { sub: ownerId, aud: "web" })
    viewerToken = await signToken(env, { sub: viewerId, aud: "web" })
    strangerToken = await signToken(env, { sub: strangerId, aud: "web" })

    app = buildApp(db, env, { rootLog: createLogger({ service: "test" }, { level: "silent" }) })
    teardown = async () => {
      await created.client.end()
      await container.stop()
    }
  }, 180_000)

  afterAll(async () => {
    await teardown?.()
  })

  beforeEach(async () => {
    await db.delete(artifact)
  })

  test("S39: a session's artifacts are listed with metadata flags and never with body columns", async () => {
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
      hasDiff: true,
      hasOldFragment: false,
      diffByteSize: Buffer.byteLength("--- a\n+++ b\n-Original.\n+Changed.\n"),
      oldFragmentByteSize: null,
    })
    expect(binary).toMatchObject({ isBinary: true, byteSize: PNG_BYTES.length })

    // The whole point of the list shape: a list view must not drag every artifact's bytes with it.
    for (const row of artifacts) {
      expect(row).not.toHaveProperty("currentContent")
      expect(row).not.toHaveProperty("baseContent")
      expect(row).not.toHaveProperty("diff")
      expect(row).not.toHaveProperty("oldFragment")
    }
  })

  test("S40: selected detail reads only its requested diff body", async () => {
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

    const res = await get(`/api/artifacts/${id}?part=diff`, ownerToken)
    expect(res.status).toBe(200)

    const body = (await res.json()) as { artifact: Record<string, unknown> }
    expect(body.artifact).toMatchObject({
      id,
      relativePath: "docs/notes.md",
      diff: "--- a\n+++ b\n-Original.\n+Changed.\n",
    })
    expect(body.artifact).not.toHaveProperty("oldFragment")
    expect(body.artifact).not.toHaveProperty("currentContent")
    expect(body.artifact).not.toHaveProperty("baseContent")
    expect(new Date(String(body.artifact.lastSeenAt)).toISOString()).toBe(body.artifact.lastSeenAt)
  })

  test("S40: selected old-fragment detail returns only its requested body", async () => {
    const id = await seedArtifact({
      path: "/work/docs/replaced.md",
      relativePath: "docs/replaced.md",
      mimeType: "text/markdown",
      isBinary: false,
      current: Buffer.from("current\n", "utf8"),
    })
    await db.update(artifact).set({ oldFragment: "original excerpt" }).where(eq(artifact.id, id))

    const res = await get(`/api/artifacts/${id}?part=oldFragment`, ownerToken)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { artifact: Record<string, unknown> }
    expect(body.artifact).toMatchObject({ oldFragment: "original excerpt" })
    expect(body.artifact).not.toHaveProperty("diff")
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
    expect(body.artifact).toMatchObject({ isBinary: true, byteSize: PNG_BYTES.length })
    expect(body.artifact).not.toHaveProperty("currentContent")
    expect(body.artifact).not.toHaveProperty("baseContent")
    expect(body.artifact).not.toHaveProperty("diff")
    expect(body.artifact).not.toHaveProperty("oldFragment")
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

  test("S41: an artifact in a project the caller does not own is invisible even to its own session route", async () => {
    const id = await seedArtifact({
      sessionId: foreignSessionId,
      path: "/other/docs/theirs.md",
      relativePath: "docs/theirs.md",
      mimeType: "text/markdown",
      isBinary: false,
      current: Buffer.from("theirs\n", "utf8"),
    })

    expect((await get(`/api/sessions/${foreignSessionId}/artifacts`, ownerToken)).status).toBe(404)
    expect((await get(`/api/artifacts/${id}`, ownerToken)).status).toBe(404)
    // Its real owner still sees it, so the join is filtering by user rather than by nothing.
    expect((await get(`/api/artifacts/${id}`, strangerToken)).status).toBe(200)
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
    expect(await res.text()).toBe("alert(document.cookie)\n")
  })

  test("S42: bytes claiming image/png that are not PNG serve as an octet-stream attachment", async () => {
    const id = await seedArtifact({
      path: "/work/fake.png",
      relativePath: "fake.png",
      mimeType: "image/png",
      isBinary: true,
      current: Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]),
    })

    const res = await get(`/api/artifacts/${id}/raw`, ownerToken)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("application/octet-stream")
    expect(res.headers.get("content-disposition")).toBe("attachment")
    expect(res.headers.get("x-content-type-options")).toBe("nosniff")
  })

  test("S43: real PNG bytes uploaded claiming text/plain are sniffed and served inline as image/png", async () => {
    const id = await seedArtifact({
      path: "/work/shot.png",
      relativePath: "shot.png",
      mimeType: "text/plain",
      isBinary: true,
      current: PNG_BYTES,
    })

    const res = await get(`/api/artifacts/${id}/raw`, ownerToken)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("image/png")
    expect(res.headers.get("content-disposition")).toBe("inline")
    expect(res.headers.get("x-content-type-options")).toBe("nosniff")
  })

  test("S44: HTML is served as text/html with its script body unmodified", async () => {
    const id = await seedArtifact({
      path: "/work/report.html",
      relativePath: "report.html",
      mimeType: "text/html",
      isBinary: false,
      current: Buffer.from(HTML, "utf8"),
    })

    const res = await get(`/api/artifacts/${id}/raw`, ownerToken)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8")

    // The body is never rewritten -- an agent's diagram must still render as authored.
    expect(await res.text()).toBe(HTML)
  })

  test("S45: SVG claiming image/svg+xml takes the markup path, never the image path", async () => {
    const id = await seedArtifact({
      path: "/work/diagram.svg",
      relativePath: "diagram.svg",
      mimeType: "image/svg+xml",
      isBinary: false,
      current: Buffer.from(SVG, "utf8"),
    })

    const res = await get(`/api/artifacts/${id}/raw`, ownerToken)
    expect(res.status).toBe(200)

    const contentType = res.headers.get("content-type") ?? ""
    expect(contentType).not.toContain("svg")
    expect(contentType).toBe("text/html; charset=utf-8")
    expect(res.headers.get("x-content-type-options")).toBe("nosniff")
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

  test("S46: raw responses return stored strong ETags and honor matching conditionals", async () => {
    const id = await seedArtifact({
      path: "/work/etag.md",
      relativePath: "etag.md",
      mimeType: "text/markdown",
      isBinary: false,
      current: Buffer.from("cached\n", "utf8"),
    })

    const first = await get(`/api/artifacts/${id}/raw`, ownerToken)
    expect(first.status).toBe(200)
    const etag = first.headers.get("etag")
    expect(etag).toBe(`"${sha256(Buffer.from("cached\n", "utf8"))}"`)

    const cached = await get(`/api/artifacts/${id}/raw`, ownerToken, {
      "if-none-match": etag ?? "",
    })
    expect(cached.status).toBe(304)
    expect(await cached.text()).toBe("")
  })

  test("S46: If-Range mismatch falls back to a complete response", async () => {
    const id = await seedArtifact({
      path: "/work/if-range.md",
      relativePath: "if-range.md",
      mimeType: "text/markdown",
      isBinary: false,
      current: Buffer.from("complete\n", "utf8"),
    })

    const res = await get(`/api/artifacts/${id}/raw`, ownerToken, {
      range: "bytes=0-2",
      "if-range": '"stale"',
    })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("complete\n")
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

  test("S41: a CLI-audience token cannot read, and an unauthenticated caller cannot either", async () => {
    const id = await seedArtifact({
      path: "/work/docs/auth.md",
      relativePath: "docs/auth.md",
      mimeType: "text/markdown",
      isBinary: false,
      current: Buffer.from("content\n", "utf8"),
    })

    const [owner] = await db.select().from(sessions).where(eq(sessions.id, SESSION_ID))
    if (!owner) throw new Error("seeded session missing")
    const cliToken = await signToken(env, { sub: owner.userId, aud: "cli" })

    expect((await get(`/api/artifacts/${id}`, cliToken)).status).toBe(401)
    expect((await get(`/api/artifacts/${id}/raw`, cliToken)).status).toBe(401)
    expect((await app.request(`/api/artifacts/${id}`)).status).toBe(401)
  })
})
