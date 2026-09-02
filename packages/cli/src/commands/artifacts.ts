import { readdir, realpath, stat } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"
import type { ArtifactUploadResponse } from "@samskara/core"
import { mapWithLimit } from "../concurrency.js"
import { warnOnServerChange } from "../config/server-scope.js"
import { resolveIo, type Writer } from "../io.js"
import { prepareUpload } from "../watcher/artifact-upload.js"
import { isSecret } from "../watcher/containment.js"

export type ResolvedFile = {
  readonly absolutePath: string
  readonly relativePath: string
}

export type ResolveError =
  | { readonly kind: "outsideBase"; readonly path: string }
  | { readonly kind: "collision"; readonly relativePath: string; readonly paths: readonly string[] }

/** `startsWith("..")` on the computed relative path, not a prefix compare of the two absolute
 * paths: `/a/b` and `/a/bc` share a string prefix but neither contains the other. */
const relativeUnder = (baseDir: string, absolutePath: string): string | null => {
  const rel = relative(baseDir, absolutePath)
  return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? null : rel
}

/**
 * Resolve symlinks before anything compares paths. A symlink sitting inside the base directory
 * and pointing outside it satisfies a lexical containment check on its own name, while the
 * `readFile` that follows walks the link to the real target -- which is how a base-directory
 * refusal turns into an upload of whatever the link pointed at.
 *
 * A path that does not resolve keeps its cwd-anchored form rather than being rejected: a file
 * that simply is not there is reported as vanished by the upload, which says more than an escape
 * error would.
 */
const canonical = async (path: string): Promise<string> => realpath(path).catch(() => resolve(path))

/** `paths` are absolute and already symlink-resolved. `baseDir` only labels them: resolving an
 * input against it would re-anchor a relative path to a directory the walk never looked in. */
export const resolveInputs = (
  paths: readonly string[],
  baseDir: string,
): ReadonlyArray<ResolvedFile> | ResolveError => {
  const candidates = paths.map((path) => {
    const absolutePath = resolve(path)
    return { absolutePath, relativePath: relativeUnder(baseDir, absolutePath) }
  })

  const outside = candidates.find((candidate) => candidate.relativePath === null)
  if (outside) return { kind: "outsideBase", path: outside.absolutePath }

  const resolved = candidates.filter(
    (candidate): candidate is ResolvedFile => candidate.relativePath !== null,
  )

  const byRelativePath = new Map<string, string[]>()
  for (const candidate of resolved) {
    const group = byRelativePath.get(candidate.relativePath) ?? []
    group.push(candidate.absolutePath)
    byRelativePath.set(candidate.relativePath, group)
  }
  const collision = [...byRelativePath.entries()].find(([, group]) => group.length > 1)
  if (collision) return { kind: "collision", relativePath: collision[0], paths: collision[1] }

  return resolved
}

/** Skips a directory entry by name without descending into it, so a walked `.cache/` never even
 * reaches `readdir`. Sorted by name so a run's output, and its tests, are not order-dependent. */
const walk = async (dir: string): Promise<readonly string[]> => {
  const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )
  const nested = await Promise.all(
    entries.map((entry): Promise<readonly string[]> => {
      if (entry.name.startsWith(".")) return Promise.resolve([])
      const path = join(dir, entry.name)
      if (entry.isDirectory()) return walk(path)
      if (!entry.isFile() || isSecret(path)) return Promise.resolve([])
      return Promise.resolve([path])
    }),
  )
  return nested.flat()
}

/** Filters only what a directory walk turns up. An explicitly named path passes through
 * unfiltered -- including one that no longer exists, so `resolveInputs`/`prepareUpload` still
 * get to report why -- because the caller named it. */
export const expandPaths = async (paths: readonly string[]): Promise<readonly string[]> => {
  const expanded = await Promise.all(
    paths.map(async (path): Promise<readonly string[]> => {
      const info = await stat(path).catch(() => null)
      if (info === null || info.isFile()) return [path]
      if (info.isDirectory()) return walk(path)
      return []
    }),
  )
  // Canonicalised here rather than in `resolveInputs`, which stays synchronous and pure: every
  // path leaving this function is absolute and symlink-free, so the containment check downstream
  // measures the file that will actually be read.
  return await Promise.all(expanded.flat().map(canonical))
}

const resolveErrorMessage = (error: ResolveError): string =>
  error.kind === "outsideBase"
    ? `${error.path} is outside the base directory; nothing was uploaded.\n`
    : `${error.paths.join(" and ")} would both write to ${error.relativePath}; nothing was uploaded.\n`

export type UploadArgs = {
  readonly sessionId: string
  readonly paths: readonly string[]
  readonly baseDir?: string
  readonly created: boolean
  readonly dryRun: boolean
}

export type UploadDeps = {
  readonly apiBase: string
  readonly token: string | null
  readonly fetch: typeof globalThis.fetch
  readonly stdout?: Writer
  readonly stderr?: Writer
}

type FileOutcome = {
  readonly relativePath: string
  readonly status: "ok" | "updated" | "failed"
  readonly reason?: string
}

/**
 * The route's own response contract, rather than a shape declared here: a new variant or a renamed
 * field reaches this code as a type error instead of silently falling through to a status code.
 * `null` covers a body that never arrived or did not parse.
 */
const readResponse = async (res: Response): Promise<ArtifactUploadResponse | null> =>
  (await res.json().catch(() => null)) as ArtifactUploadResponse | null

/** `aborted` carries no outcome: the file was either never posted, or answered with the 409 that
 * ends the run. Either way there is nothing to report for it. */
type FileResult =
  | { readonly kind: "done"; readonly outcome: FileOutcome }
  | { readonly kind: "aborted" }

const uploadOne = async (
  deps: Pick<UploadDeps, "apiBase" | "fetch">,
  token: string,
  args: UploadArgs,
  file: ResolvedFile,
  isAborted: () => boolean,
): Promise<FileResult> => {
  if (isAborted()) return { kind: "aborted" }

  const prepared = await prepareUpload({
    sessionId: args.sessionId,
    path: file.absolutePath,
    relativePath: file.relativePath,
    created: args.created,
    observedAt: new Date().toISOString(),
  })
  if (!prepared.ok) {
    return {
      kind: "done",
      outcome: { relativePath: file.relativePath, status: "failed", reason: prepared.reason },
    }
  }

  // Checked again here, not only before claiming: `prepareUpload` reads the file from disk, and a
  // slower read must not race an earlier file's response past the point where the run was aborted.
  if (isAborted()) return { kind: "aborted" }

  const res = await deps
    .fetch(`${deps.apiBase}/api/artifacts`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(prepared.upload),
    })
    .catch(() => null)

  if (res === null) {
    return {
      kind: "done",
      outcome: { relativePath: file.relativePath, status: "failed", reason: "unreachable" },
    }
  }
  // Answers both "no such session" and "not your session" -- neither becomes true again while
  // the run continues, so it aborts the whole run rather than failing once per remaining file.
  if (res.status === 409) return { kind: "aborted" }

  const body = await readResponse(res)
  if (res.status >= 200 && res.status < 300) {
    return {
      kind: "done",
      outcome: {
        relativePath: file.relativePath,
        status: body !== null && "updated" in body && body.updated ? "updated" : "ok",
      },
    }
  }

  // The server names its own refusals, so the status code is only the fallback for a body that
  // did not arrive or did not parse.
  const reason = body !== null && "error" in body ? body.error : String(res.status)
  return { kind: "done", outcome: { relativePath: file.relativePath, status: "failed", reason } }
}

const STATUS_WIDTH = 9

const reportLine = (outcome: FileOutcome): string =>
  `  ${outcome.status.padEnd(STATUS_WIDTH)}${outcome.relativePath}` +
  `${outcome.reason === undefined ? "" : `  (${outcome.reason})`}\n`

const dryRunPreview = (sessionId: string, files: readonly ResolvedFile[]): string => {
  const width = files.reduce((max, file) => Math.max(max, file.absolutePath.length), 0)
  const header = `would upload ${files.length} file${files.length === 1 ? "" : "s"} to session ${sessionId}:\n`
  const lines = files.map(
    (file) => `  ${file.absolutePath.padEnd(width)} -> ${file.relativePath}\n`,
  )
  return header + lines.join("")
}

const UPLOAD_CONCURRENCY = 4

export const uploadArtifactsCommand = async (
  args: UploadArgs,
  deps: UploadDeps,
): Promise<number> => {
  const { stdout, stderr } = resolveIo(deps)
  await warnOnServerChange(stderr).catch(() => {})

  if (!deps.token) {
    stdout.write("Not logged in. Run `samskara login` first.\n")
    return 1
  }
  const token = deps.token

  // Canonical on both sides or neither: `/tmp` is a symlink to `/private/tmp` on macOS, so
  // comparing a resolved file against an unresolved base would read as an escape from it.
  const baseDir = await canonical(args.baseDir ?? process.cwd())
  const expandedPaths = await expandPaths(args.paths)
  const resolved = resolveInputs(expandedPaths, baseDir)
  if ("kind" in resolved) {
    stdout.write(resolveErrorMessage(resolved))
    return 1
  }

  if (args.dryRun) {
    stdout.write(dryRunPreview(args.sessionId, resolved))
    return 0
  }

  // `mapWithLimit` stops a batch by throwing, which would discard the outcomes already collected.
  // A 409 has to keep them -- the files that landed before it did still landed -- so the stop is a
  // flag `uploadOne` reads, and every file after it returns `aborted` rather than an outcome.
  let sessionGone = false
  const results = await mapWithLimit(resolved, UPLOAD_CONCURRENCY, async (file) => {
    const result = await uploadOne(deps, token, args, file, () => sessionGone)
    if (result.kind === "aborted") sessionGone = true
    return result
  })

  const done = results.flatMap((result) => (result.kind === "done" ? [result.outcome] : []))
  const body = done.map((outcome) => reportLine(outcome)).join("")

  if (sessionGone) {
    stdout.write(body)
    stdout.write(`\nSession ${args.sessionId} does not exist, or is not yours. Stopping.\n`)
    return 1
  }

  const failed = done.filter((outcome) => outcome.status === "failed").length
  stdout.write(`${body}\n${done.length - failed} uploaded, ${failed} failed\n`)
  return failed > 0 ? 1 : 0
}
