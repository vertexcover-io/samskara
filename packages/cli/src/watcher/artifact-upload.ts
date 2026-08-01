import { createHash } from "node:crypto"
import { readFile, readdir } from "node:fs/promises"
import { extname, join } from "node:path"
import { MAX_BINARY_BYTES, MAX_DIFF_BYTES, MAX_TEXT_BYTES } from "@samskara/core"
import { createTwoFilesPatch } from "diff"
import type pino from "pino"
import type { QueueEntry } from "./artifact-queue.js"

export { MAX_BINARY_BYTES, MAX_DIFF_BYTES, MAX_TEXT_BYTES }

export type ArtifactUploadDeps = {
  readonly fileHistoryDir: string
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
  readonly baseHash?: string
  readonly diff?: string
  readonly oldFragment?: string
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

export const computeArtifactDiff = (
  base: string,
  current: string,
  relativePath: string,
): string | null => {
  const patch = createTwoFilesPatch(relativePath, relativePath, base, current)
  return Buffer.byteLength(patch) > MAX_DIFF_BYTES ? null : patch
}

const versionOf = (name: string, hash: string): number | null => {
  const suffix = name.startsWith(`${hash}@v`) ? name.slice(hash.length + 2) : null
  if (suffix === null || !/^\d+$/.test(suffix)) return null
  return Number.parseInt(suffix, 10)
}

/**
 * The named `@vN` recovers the hash only. `@vN` is the state before the Nth edit, not before the
 * session, so the lowest surviving version is the closest thing to a pre-session base -- freezing
 * the named one would store an intermediate state and produce a permanently misleading diff.
 */
export const resolveBase = async (
  deps: ArtifactUploadDeps,
  entry: QueueEntry,
): Promise<{ readonly baseContent: Buffer; readonly backupPath: string } | null> => {
  if (!entry.backupFileName) return null

  const [hash] = entry.backupFileName.split("@v")
  if (!hash) return null

  const directory = join(deps.fileHistoryDir, entry.sessionId)
  try {
    const names = await readDirNames(directory)
    const versions = names
      .map((name) => ({ name, version: versionOf(name, hash) }))
      .filter(
        (candidate): candidate is { name: string; version: number } => candidate.version !== null,
      )
      .sort((a, b) => a.version - b.version)

    const lowest = versions[0]
    if (!lowest) return null

    const backupPath = join(directory, lowest.name)
    return { baseContent: await readFile(backupPath), backupPath }
  } catch (error) {
    deps.log.debug(
      { directory, backupFileName: entry.backupFileName, err: error },
      "artifact base could not be resolved; degrading to editedUnknownBase",
    )
    return null
  }
}

const readDirNames = async (path: string): Promise<ReadonlyArray<string>> =>
  readdir(path, { withFileTypes: true }).then((entries) =>
    entries.filter((entry) => entry.isFile()).map((entry) => entry.name),
  )

const exceedsCap = (size: number, isBinary: boolean): boolean =>
  size > (isBinary ? MAX_BINARY_BYTES : MAX_TEXT_BYTES)

type ResolvedBase = {
  readonly changeKind: ArtifactUpload["changeKind"]
  readonly baseContent?: string
  readonly baseHash?: string
  readonly diff?: string
}

const baseFieldsFor = async (
  deps: ArtifactUploadDeps,
  entry: QueueEntry,
  current: Buffer,
  isBinary: boolean,
): Promise<ResolvedBase> => {
  if (entry.changeKind !== "edited") return { changeKind: entry.changeKind }

  const resolved = await resolveBase(deps, entry)
  if (!resolved) return { changeKind: "editedUnknownBase" }

  const base = resolved.baseContent
  const baseIsBinary = classifyContentType(base, entry.relativePath).isBinary
  const diff =
    isBinary || baseIsBinary
      ? null
      : computeArtifactDiff(base.toString("utf8"), current.toString("utf8"), entry.relativePath)

  return {
    changeKind: "edited",
    baseContent: base.toString(isBinary ? "base64" : "utf8"),
    baseHash: sha256(base),
    ...(diff === null ? {} : { diff }),
  }
}

/**
 * The seam where a future redaction policy would transform content: everything the upload
 * carries is derived here, between reading the bytes and building the payload.
 */
export const prepareUpload = async (
  deps: ArtifactUploadDeps,
  entry: QueueEntry,
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

  const base = await baseFieldsFor(deps, entry, current, isBinary)

  return {
    sessionId: entry.sessionId,
    path: entry.path,
    relativePath: entry.relativePath,
    mimeType,
    changeKind: base.changeKind,
    encoding: isBinary ? "base64" : "utf8",
    currentContent: current.toString(isBinary ? "base64" : "utf8"),
    currentHash: sha256(current),
    ...(base.baseContent === undefined ? {} : { baseContent: base.baseContent }),
    ...(base.baseHash === undefined ? {} : { baseHash: base.baseHash }),
    ...(base.diff === undefined ? {} : { diff: base.diff }),
    ...(entry.oldFragment === undefined ? {} : { oldFragment: entry.oldFragment }),
    observedAt: entry.observedAt,
  }
}
