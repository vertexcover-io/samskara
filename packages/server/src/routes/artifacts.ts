import { createHash } from "node:crypto"
import { zValidator } from "@hono/zod-validator"
import {
  type ArtifactUploadPayload,
  MAX_BINARY_BYTES,
  MAX_TEXT_BYTES,
  artifactUploadSchema,
} from "@samskara/core"
import { Hono } from "hono"
import { z } from "zod"
import type { Db } from "../db/client.js"
import { type ServeHeaders, serveHeadersFor } from "../lib/artifact-serving.js"
import type { Env } from "../lib/env.js"
import { type AuthVariables, requireAuth } from "../lib/require-auth.js"
import {
  type ArtifactDetailRow,
  type ArtifactSummaryRow,
  getArtifact,
  getArtifactBytes,
  getArtifactBytesByPath,
  upsertArtifact,
} from "../repositories/artifacts.repo.js"
import * as sessionsRepo from "../repositories/sessions.repo.js"

type Deps = { readonly db: Db; readonly env: Env }

const rawQuerySchema = z.object({ which: z.enum(["base", "current"]).default("current") })

const decode = (payload: ArtifactUploadPayload, content: string): Buffer =>
  Buffer.from(content, payload.encoding === "base64" ? "base64" : "utf8")

const sha256 = (content: Buffer): string => createHash("sha256").update(content).digest("hex")

/**
 * A separate route from `/api/ingest` rather than an extra field on the ingest payload: artifact
 * failures must not block transcript sync, and the size limits differ from the ingest message cap.
 */
export const serializeArtifact = <T extends ArtifactSummaryRow | ArtifactDetailRow>(row: T) => ({
  ...row,
  firstSeenAt: new Date(row.firstSeenAt).toISOString(),
  lastSeenAt: new Date(row.lastSeenAt).toISOString(),
})

export type RangeResponse =
  | { readonly kind: "full"; readonly body: Buffer; readonly headers: Record<string, string> }
  | {
      readonly kind: "partial"
      readonly body: Buffer
      readonly headers: Record<string, string>
    }
  | { readonly kind: "unsatisfiable"; readonly headers: Record<string, string> }

const RANGE = /^bytes=(\d*)-(\d*)$/

const baseHeaders = (serve: ServeHeaders): Record<string, string> => ({
  "content-type": serve.contentType,
  "content-disposition": serve.disposition,
  "x-content-type-options": "nosniff",
  "accept-ranges": "bytes",
})

/**
 * A single `bytes=` range only. Multipart ranges would require a boundary-delimited body, and no
 * client this serves (a `<video>` seeking a captured recording) asks for one.
 */
export const rangeResponse = (
  bytes: Buffer,
  serve: ServeHeaders,
  rangeHeader: string | undefined,
): RangeResponse => {
  const headers = baseHeaders(serve)
  if (rangeHeader === undefined) {
    return {
      kind: "full",
      body: bytes,
      headers: { ...headers, "content-length": `${bytes.length}` },
    }
  }

  const match = RANGE.exec(rangeHeader.trim())
  if (!match) return { kind: "full", body: bytes, headers }

  const [, rawStart = "", rawEnd = ""] = match
  const total = bytes.length

  // `bytes=-N` is a suffix request: the final N bytes, not a range starting at zero.
  const start = rawStart === "" ? Math.max(total - Number(rawEnd), 0) : Number(rawStart)
  const end = rawStart === "" || rawEnd === "" ? total - 1 : Math.min(Number(rawEnd), total - 1)

  if (rawStart === "" && rawEnd === "") return { kind: "full", body: bytes, headers }
  if (start >= total || start > end) {
    return { kind: "unsatisfiable", headers: { ...headers, "content-range": `bytes */${total}` } }
  }

  return {
    kind: "partial",
    body: bytes.subarray(start, end + 1),
    headers: {
      ...headers,
      "content-range": `bytes ${start}-${end}/${total}`,
      "content-length": `${end - start + 1}`,
    },
  }
}

export const artifactRoutes = ({ db, env }: Deps): Hono<{ Variables: AuthVariables }> => {
  const app = new Hono<{ Variables: AuthVariables }>()

  app.post(
    "/",
    requireAuth({ db, env }, ["cli"]),
    zValidator("json", artifactUploadSchema),
    async (context) => {
      const payload = context.req.valid("json")
      const isBinary = payload.encoding === "base64"
      const current = decode(payload, payload.currentContent)

      // The client hashed the decoded bytes before the network hop, so this catches transport
      // corruption before it becomes a permanently stored wrong artifact.
      if (sha256(current) !== payload.currentHash) {
        return context.json({ error: "hashMismatch" } as const, 400)
      }

      // The client already skips oversize files; the server does not trust that.
      if (current.byteLength > (isBinary ? MAX_BINARY_BYTES : MAX_TEXT_BYTES)) {
        return context.json({ error: "artifactTooLarge" } as const, 413)
      }

      // Scoped to the caller, not just existence: an `aud:cli` token is valid for any CLI
      // installation, so an unscoped check would let one user's daemon attach artifacts to
      // another user's session by guessing its id. Absent-or-not-yours both retry as 409 --
      // the worker backs off the same way for "not synced yet" as for "not mine".
      if (!(await sessionsRepo.existsForUser(db, payload.sessionId, context.get("user").id))) {
        return context.json({ error: "sessionNotFound" } as const, 409)
      }

      const base =
        payload.baseContent === undefined ? undefined : decode(payload, payload.baseContent)

      const result = await upsertArtifact(db, {
        sessionId: payload.sessionId,
        path: payload.path,
        relativePath: payload.relativePath,
        mimeType: payload.mimeType,
        isBinary,
        changeKind: payload.changeKind,
        currentContent: current,
        currentHash: payload.currentHash,
        ...(base === undefined ? {} : { baseContent: base }),
        ...(payload.baseHash === undefined ? {} : { baseHash: payload.baseHash }),
        ...(payload.diff === undefined ? {} : { diff: payload.diff }),
        ...(payload.oldFragment === undefined ? {} : { oldFragment: payload.oldFragment }),
      })

      context.get("log")?.setBindings({
        sessionId: payload.sessionId,
        relativePath: payload.relativePath,
        updated: result.updated,
      })
      return context.json(result, 200)
    },
  )

  app.get("/:artifactId", requireAuth({ db, env }, ["web"]), async (context) => {
    const row = await getArtifact(db, context.get("user").id, context.req.param("artifactId"))
    if (row === null) return context.json({ error: "artifactNotFound" } as const, 404)
    return context.json({ artifact: serializeArtifact<ArtifactDetailRow>(row) })
  })

  /**
   * The same bytes as `/:artifactId/raw`, addressed by the path the artifact had on disk. A
   * captured report links its screenshots and recordings relatively, so serving the document from a
   * path-shaped URL is what lets the browser resolve those references -- no html is rewritten.
   *
   * Registered before `/:artifactId` so the static `session` segment wins the match.
   */
  app.get(
    "/session/:sessionId/files/*",
    requireAuth({ db, env }, ["web"]),
    zValidator("query", rawQuerySchema),
    async (context) => {
      const { which } = context.req.valid("query")
      const marker = "/files/"
      const at = context.req.path.indexOf(marker)
      const relativePath = decodeURIComponent(context.req.path.slice(at + marker.length))

      const found = await getArtifactBytesByPath(
        db,
        context.get("user").id,
        context.req.param("sessionId"),
        relativePath,
        which,
      )
      if (found === null) return context.json({ error: "artifactNotFound" } as const, 404)

      const serve = serveHeadersFor(found.bytes, found.isBinary)
      const response = rangeResponse(found.bytes, serve, context.req.header("range"))

      if (response.kind === "unsatisfiable") return context.body(null, 416, response.headers)
      return context.body(response.body, response.kind === "partial" ? 206 : 200, response.headers)
    },
  )

  app.get(
    "/:artifactId/raw",
    requireAuth({ db, env }, ["web"]),
    zValidator("query", rawQuerySchema),
    async (context) => {
      const { which } = context.req.valid("query")
      const found = await getArtifactBytes(
        db,
        context.get("user").id,
        context.req.param("artifactId"),
        which,
      )
      if (found === null) return context.json({ error: "artifactNotFound" } as const, 404)

      // `found.mimeType` is what the client claimed on upload and is never consulted here:
      // echoing it is the stored-XSS vector this route exists to close.
      const serve = serveHeadersFor(found.bytes, found.isBinary)
      const response = rangeResponse(found.bytes, serve, context.req.header("range"))

      if (response.kind === "unsatisfiable") return context.body(null, 416, response.headers)
      return context.body(response.body, response.kind === "partial" ? 206 : 200, response.headers)
    },
  )

  return app
}
