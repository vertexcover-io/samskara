import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { extname } from "node:path"
import { MAX_BINARY_BYTES, MAX_TEXT_BYTES } from "@samskara/core"
import type pino from "pino"
import type { ArtifactQueueEntry } from "./artifact-queue.js"

export type ArtifactUploadDeps = {
  readonly log: pino.Logger
}

export type ArtifactUpload = {
  readonly sessionId: string
  readonly path: string
  readonly relativePath: string
  readonly mimeType: string
  readonly changeKind: "created" | "edited" | "editedUnknownBase"
  readonly encoding: "utf8" | "base64"
  readonly currentContent: string
  readonly currentHash: string
  readonly baseContent?: string
  readonly observedAt: string
}

const MIME_BY_EXTENSION: Record<string, string> = {
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
  ".json": "application/json",
  ".jsonl": "application/x-ndjson",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".toml": "text/toml",
  ".csv": "text/csv",
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".cjs": "text/javascript",
  ".jsx": "text/jsx",
  ".ts": "text/x-typescript",
  ".mts": "text/x-typescript",
  ".cts": "text/x-typescript",
  ".tsx": "text/tsx",
  ".py": "text/x-python",
  ".rs": "text/x-rust",
  ".go": "text/x-go",
  ".rb": "text/x-ruby",
  ".java": "text/x-java",
  ".sh": "text/x-shellscript",
  ".sql": "text/x-sql",
  ".xml": "text/xml",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".wasm": "application/wasm",
}

const sha256 = (content: Buffer): string => createHash("sha256").update(content).digest("hex")

/**
 * Content-driven rather than extension-driven: a buffer is text when it holds no NUL and
 * survives a UTF-8 round trip. The extension only selects the reported label.
 */
export const classifyContentType = (
  content: Buffer,
  fileName: string,
): { readonly isBinary: boolean; readonly mimeType: string } => {
  const isBinary = content.includes(0) || !content.equals(Buffer.from(content.toString("utf8")))
  const mapped = MIME_BY_EXTENSION[extname(fileName).toLowerCase()]
  if (isBinary) return { isBinary, mimeType: mapped ?? "application/octet-stream" }
  return { isBinary, mimeType: mapped ?? "text/plain" }
}

const exceedsCap = (size: number, isBinary: boolean): boolean =>
  size > (isBinary ? MAX_BINARY_BYTES : MAX_TEXT_BYTES)

export const prepareUpload = async (
  deps: ArtifactUploadDeps,
  entry: ArtifactQueueEntry,
): Promise<ArtifactUpload | null> => {
  const current = await readFile(entry.path).catch((error: unknown) => {
    deps.log.debug({ path: entry.path, err: error }, "artifact vanished before upload; skipping")
    return null
  })
  if (!current) return null

  const { isBinary, mimeType } = classifyContentType(current, entry.relativePath)

  if (exceedsCap(current.byteLength, isBinary)) {
    deps.log.warn(
      { path: entry.path, size: current.byteLength, isBinary },
      "artifact exceeds the size cap; skipping rather than truncating",
    )
    return null
  }

  // Presence, not truthiness: a file that was empty before the session has a known, empty base.
  const changeKind = entry.created
    ? "created"
    : entry.base !== undefined
      ? "edited"
      : "editedUnknownBase"

  return {
    sessionId: entry.sessionId,
    path: entry.path,
    relativePath: entry.relativePath,
    mimeType,
    changeKind,
    encoding: isBinary ? "base64" : "utf8",
    currentContent: current.toString(isBinary ? "base64" : "utf8"),
    currentHash: sha256(current),
    ...(entry.base === undefined ? {} : { baseContent: entry.base }),
    observedAt: entry.observedAt,
  }
}
