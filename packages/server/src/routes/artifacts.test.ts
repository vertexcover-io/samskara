import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import { createLogger } from "@samskara/core"
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest"
import { buildApp } from "../app.js"
import { type Db, createDb } from "../db/client.js"
import { artifact, projects, sessions, users } from "../db/schema.js"
import type { Env } from "../lib/env.js"
import { signToken } from "../lib/jwt.js"

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
  artifactPreviewSandbox: true,
}

const sha256 = (content: string | Buffer): string =>
  createHash("sha256").update(content).digest("hex")

const SESSION_ID = "artifact-session"
const OTHER_SESSION_ID = "artifact-session-other"
const ABSENT_SESSION_ID = "artifact-session-absent"
const FILE_PATH = "/work/app/docs/notes.md"

type UploadOverrides = {
  readonly sessionId?: string
  readonly path?: string
  readonly currentContent?: string
  readonly currentHash?: string
  readonly baseContent?: string | null
  readonly encoding?: "utf8" | "base64"
  readonly mimeType?: string
}

const upload = (over: UploadOverrides = {}) => {
  const currentContent = over.currentContent ?? "changed content\n"
  const base = over.baseContent === null ? undefined : (over.baseContent ?? "original content\n")
  const encoding = over.encoding ?? "utf8"
  const decodedBase = base === undefined ? undefined : Buffer.from(base, encoding)
  return {
    sessionId: over.sessionId ?? SESSION_ID,
    path: over.path ?? FILE_PATH,
    relativePath: "docs/notes.md",
    mimeType: over.mimeType ?? "text/markdown",
    changeKind: base === undefined ? "created" : "edited",
    encoding,
    currentContent,
    currentHash: over.currentHash ?? sha256(Buffer.from(currentContent, encoding)),
    ...(base === undefined ? {} : { baseContent: base }),
    ...(decodedBase === undefined ? {} : { baseHash: sha256(decodedBase) }),
    ...(base === undefined ? {} : { diff: "--- a\n+++ b\n-original\n+changed\n" }),
    observedAt: "2026-07-28T12:00:00.000Z",
  }
}

describe.skipIf(!dockerAvailable())("artifacts route", () => {
  let container: StartedPostgreSqlContainer
  let teardown: () => Promise<void>
  let db: Db
  let app: ReturnType<typeof buildApp>
  let cliToken: string
  let webToken: string

  /** `as: "none"` sends no Authorization header at all; omitting it uses the CLI token. */
  const post = (payload: unknown, as: string | "none" = "") =>
    app.request("/api/artifacts", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(as === "none" ? {} : { authorization: `Bearer ${as === "" ? cliToken : as}` }),
      },
      body: JSON.stringify(payload),
    })

  const seedSession = async (id: string, userId: string, projectId: string) => {
    await db.insert(sessions).values({ id, source: "claude_code", userId, projectId })
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

    const [user] = await db
      .insert(users)
      .values({ githubId: 9191, githubLogin: "artifact-user" })
      .returning()
    if (!user) throw new Error("seed user failed")
    const [project] = await db
      .insert(projects)
      .values({ name: "widget", slug: "artifact-widget", ownerId: user.id })
      .returning()
    if (!project) throw new Error("seed project failed")

    await seedSession(SESSION_ID, user.id, project.id)
    await seedSession(OTHER_SESSION_ID, user.id, project.id)

    cliToken = await signToken(env, { sub: user.id, aud: "cli" })
    webToken = await signToken(env, { sub: user.id, aud: "web" })
    app = buildApp(db, env, {
      rootLog: createLogger({ service: "test" }, { level: "silent" }),
    })
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

  test("S26: an uploaded artifact is stored with its base, current content, and diff", async () => {
    const payload = upload()
    const res = await post(payload)

    expect(res.status).toBe(200)
    const body = (await res.json()) as { artifactId: string; updated: boolean }
    expect(body.artifactId).toBeTruthy()

    const [row] = await db.select().from(artifact).where(eq(artifact.id, body.artifactId))
    if (!row) throw new Error("no artifact row was stored")

    // Decoded bytes, not the wire strings: a base64/utf8 mix-up would survive a string compare.
    expect(row.currentContent?.toString("utf8")).toBe("changed content\n")
    expect(row.baseContent?.toString("utf8")).toBe("original content\n")
    expect(row.diff).toBe(payload.diff)
    expect(row.relativePath).toBe("docs/notes.md")
    expect(row.mimeType).toBe("text/markdown")
    expect(row.isBinary).toBe(false)
    expect(row.editCount).toBe(1)
  })

  test("S26: a binary artifact round-trips its exact bytes through base64", async () => {
    // A NUL and a lone 0xFF: neither survives a UTF-8 round trip, so a text path would corrupt it.
    const bytes = Buffer.from([0x00, 0xff, 0x10, 0x00, 0x7f])
    const res = await post(
      upload({
        encoding: "base64",
        currentContent: bytes.toString("base64"),
        currentHash: sha256(bytes),
        baseContent: null,
        mimeType: "application/octet-stream",
      }),
    )

    expect(res.status).toBe(200)
    const { artifactId } = (await res.json()) as { artifactId: string }
    const [row] = await db.select().from(artifact).where(eq(artifact.id, artifactId))
    expect(row?.currentContent?.equals(bytes)).toBe(true)
    expect(row?.isBinary).toBe(true)
  })

  test("S27: a second upload updates the current content but never the base", async () => {
    const first = await post(upload({ baseContent: "original", currentContent: "v1" }))
    expect(first.status).toBe(200)

    const second = await post(upload({ baseContent: "IMPOSTOR", currentContent: "v2" }))
    expect(second.status).toBe(200)
    expect(await second.json()).toMatchObject({ updated: true })

    const rows = await db.select().from(artifact).where(eq(artifact.sessionId, SESSION_ID))
    expect(rows).toHaveLength(1)
    // The impostor base is discarded: were it accepted, every future diff would be wrong.
    expect(rows[0]?.baseContent?.toString("utf8")).toBe("original")
    expect(rows[0]?.currentContent?.toString("utf8")).toBe("v2")
    expect(rows[0]?.editCount).toBe(2)
  })

  test("S27: an upload carrying no base leaves a stored base intact", async () => {
    await post(upload({ baseContent: "original", currentContent: "v1" }))
    const res = await post(upload({ baseContent: null, currentContent: "v2" }))

    expect(res.status).toBe(200)
    const rows = await db.select().from(artifact).where(eq(artifact.sessionId, SESSION_ID))
    expect(rows[0]?.baseContent?.toString("utf8")).toBe("original")
  })

  test("S28: the same artifact posted twice is one row", async () => {
    const payload = upload()

    const first = await post(payload)
    expect(await first.json()).toMatchObject({ updated: false })

    const second = await post(payload)
    expect(await second.json()).toMatchObject({ updated: true })

    const rows = await db.select().from(artifact).where(eq(artifact.sessionId, SESSION_ID))
    expect(rows).toHaveLength(1)
  })

  test("S29: the same file captured by two sessions yields two independent rows", async () => {
    await post(upload({ sessionId: SESSION_ID, baseContent: "base-one", currentContent: "one" }))
    await post(
      upload({ sessionId: OTHER_SESSION_ID, baseContent: "base-two", currentContent: "two" }),
    )

    const rows = await db.select().from(artifact).where(eq(artifact.path, FILE_PATH))
    expect(rows).toHaveLength(2)

    const bySession = new Map(rows.map((row) => [row.sessionId, row]))
    expect(bySession.get(SESSION_ID)?.baseContent?.toString("utf8")).toBe("base-one")
    expect(bySession.get(OTHER_SESSION_ID)?.baseContent?.toString("utf8")).toBe("base-two")
  })

  test("S30: an artifact for an unknown session is refused as retryable, then lands once the session exists", async () => {
    const payload = upload({ sessionId: ABSENT_SESSION_ID })

    const refused = await post(payload)
    expect(refused.status).toBe(409)
    expect(await refused.json()).toEqual({ error: "sessionNotFound" })
    expect(
      await db.select().from(artifact).where(eq(artifact.sessionId, ABSENT_SESSION_ID)),
    ).toHaveLength(0)

    const [session] = await db.select().from(sessions).where(eq(sessions.id, SESSION_ID))
    if (!session) throw new Error("seeded session missing")
    await seedSession(ABSENT_SESSION_ID, session.userId, session.projectId)

    const accepted = await post(payload)
    expect(accepted.status).toBe(200)
    expect(
      await db.select().from(artifact).where(eq(artifact.sessionId, ABSENT_SESSION_ID)),
    ).toHaveLength(1)

    await db.delete(sessions).where(eq(sessions.id, ABSENT_SESSION_ID))
  })

  test("R15: a session belonging to another user is refused, not attached to", async () => {
    const [otherUser] = await db
      .insert(users)
      .values({ githubId: 9192, githubLogin: "artifact-other-user" })
      .returning()
    if (!otherUser) throw new Error("seed other user failed")
    const [otherProject] = await db
      .insert(projects)
      .values({ name: "gadget", slug: "artifact-gadget", ownerId: otherUser.id })
      .returning()
    if (!otherProject) throw new Error("seed other project failed")
    const otherSessionId = "artifact-session-belongs-to-someone-else"
    await seedSession(otherSessionId, otherUser.id, otherProject.id)

    // cliToken authenticates as the first seeded user; the session above is a different user's.
    // Existence alone must not be enough -- an aud:cli token is valid for any daemon, so an
    // unscoped check would let one user's daemon write artifacts onto another user's session.
    const res = await post(upload({ sessionId: otherSessionId }))

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: "sessionNotFound" })
    expect(
      await db.select().from(artifact).where(eq(artifact.sessionId, otherSessionId)),
    ).toHaveLength(0)

    await db.delete(sessions).where(eq(sessions.id, otherSessionId))
    await db.delete(projects).where(eq(projects.id, otherProject.id))
    await db.delete(users).where(eq(users.id, otherUser.id))
  })

  test("S31: a payload whose hash does not match its content is refused", async () => {
    const res = await post(upload({ currentHash: sha256("something else entirely") }))

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "hashMismatch" })
    expect(await db.select().from(artifact).where(eq(artifact.sessionId, SESSION_ID))).toHaveLength(
      0,
    )
  })

  test("S32: an oversize payload is refused by the server", async () => {
    // Just past the 5 MB text cap -- the client skips these, but the server does not trust that.
    const oversize = "x".repeat(5 * 1024 * 1024 + 1)
    const res = await post(
      upload({ currentContent: oversize, currentHash: sha256(oversize), baseContent: null }),
    )

    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: "artifactTooLarge" })
    expect(await db.select().from(artifact).where(eq(artifact.sessionId, SESSION_ID))).toHaveLength(
      0,
    )
  })

  const byPath = (path: string, as: string | "none" = "", headers: Record<string, string> = {}) =>
    app.request(`/api/artifacts/session/${SESSION_ID}/files/${path}`, {
      headers: {
        ...(as === "none" ? {} : { cookie: `session=${as === "" ? webToken : as}` }),
        ...headers,
      },
    })

  test("S34: an artifact is served by the path it had on disk, so a document resolves its own siblings", async () => {
    await post(upload({ currentContent: "# notes\n" }))

    const res = await byPath("docs/notes.md")

    expect(res.status).toBe(200)
    expect(await res.text()).toBe("# notes\n")
  })

  test("S34: the path route serves markup sandboxed, widened to this origin and nothing else", async () => {
    await post(upload({ currentContent: "<!doctype html><p>hi</p>" }))

    const csp = (await byPath("docs/notes.md")).headers.get("content-security-policy") ?? ""

    // Scripts run so an agent-authored report still renders, but the document stays origin-less
    // and can only reach back to us -- never an attacker's collector.
    expect(csp).toContain("sandbox allow-scripts")
    expect(csp).not.toContain("allow-same-origin")
    expect(csp).toContain("default-src 'none'")
    // Both of our origins: the page is reachable directly and through the web app's proxy, and a
    // subresource resolves against whichever one served the document.
    expect(csp).toContain(`img-src ${env.publicBaseUrl} ${env.webBaseUrl}`)
    expect(csp).toContain(`media-src ${env.publicBaseUrl} ${env.webBaseUrl}`)
  })

  test("S34: the uuid route stays as strict as it was -- only the path route widens", async () => {
    await post(upload({ currentContent: "<!doctype html><p>hi</p>" }))
    const [row] = await db.select({ id: artifact.id }).from(artifact)
    if (!row) throw new Error("upload did not store a row")

    const res = await app.request(`/api/artifacts/${row.id}/raw`, {
      headers: { cookie: `session=${webToken}` },
    })
    const csp = res.headers.get("content-security-policy") ?? ""

    expect(csp).toContain("default-src 'none'")
    expect(csp).not.toContain(env.publicBaseUrl)
  })

  test("S34: opting the sandbox off serves the same markup with no policy at all", async () => {
    await post(upload({ currentContent: "<!doctype html><p>hi</p>" }))

    const opted = buildApp(
      db,
      { ...env, artifactPreviewSandbox: false },
      {
        rootLog: createLogger({ service: "test" }, { level: "silent" }),
      },
    )
    const res = await opted.request(`/api/artifacts/session/${SESSION_ID}/files/docs/notes.md`, {
      headers: { cookie: `session=${webToken}` },
    })

    // No policy rather than a relaxed one: the document becomes an ordinary same-origin page, so
    // its media authenticates -- and any script in it acts as the signed-in user.
    expect(res.status).toBe(200)
    expect(res.headers.get("content-security-policy")).toBeNull()
  })

  test("S34: a range request is honoured, so a captured video can seek inside the frame", async () => {
    await post(upload({ currentContent: "0123456789" }))

    const res = await byPath("docs/notes.md", "", { range: "bytes=2-5" })

    expect(res.status).toBe(206)
    expect(await res.text()).toBe("2345")
  })

  test("S34: a path naming no captured artifact is 404, and a traversal reaches no filesystem", async () => {
    await post(upload())

    expect((await byPath("docs/missing.md")).status).toBe(404)
    // Nothing is opened by name here -- the segment simply fails to equal a captured path.
    expect((await byPath("../../../../etc/passwd")).status).toBe(404)
  })

  test("S34: a stranger cannot read another user's artifact by guessing its path", async () => {
    await post(upload())
    const [other] = await db
      .insert(users)
      .values({ githubId: 9192, githubLogin: "artifact-stranger" })
      .returning()
    if (!other) throw new Error("seed stranger failed")
    const stranger = await signToken(env, { sub: other.id, aud: "web" })

    // A real, authenticated account that simply does not own this project. 404 rather than 403,
    // so the reply never confirms the path exists.
    expect((await byPath("docs/notes.md", stranger)).status).toBe(404)
    expect((await byPath("docs/notes.md", "none")).status).toBe(401)
  })

  test("S33: an unauthenticated caller cannot upload", async () => {
    const res = await post(upload(), "none")
    expect(res.status).toBe(401)
  })

  test("S33: a web-audience token cannot upload", async () => {
    const webToken = await signToken(env, { sub: "someone", aud: "web" })
    const res = await post(upload(), webToken)
    expect(res.status).toBe(401)
  })
})
