import { isAbsolute, resolve } from "node:path"
import type { NormalizedMessage, ParsedRecord } from "@samskara/core"

export type PotentialArtifact = {
  readonly path: string
  readonly created: boolean
  readonly base?: string
}

const absolute = (path: string, cwd: string): string =>
  isAbsolute(path) ? path : resolve(cwd, path)

export const mergeArtifact = (a: PotentialArtifact, b: PotentialArtifact): PotentialArtifact => {
  const created = a.created || b.created
  return {
    path: a.path,
    created,
    // A file the session created has no pre-session state, so a base seen later is its own output.
    base: created ? a.base : (a.base ?? b.base),
  }
}

const timeOf = (record: ParsedRecord): number => {
  const stamp = record.messages.find((message) => message.timestamp !== undefined)?.timestamp
  return stamp === undefined ? 0 : Date.parse(stamp)
}

/**
 * Only the normalized messages are read: a `wrote` effect is what any harness's write tool did,
 * and an `edited` fileEvent is a file the human changed outside the agent. Neither needs the
 * harness's own payload shape.
 */
const artifactOf = (message: NormalizedMessage, cwd: string): PotentialArtifact | undefined => {
  if (message.msgType === "toolResult" && message.details.metadata?.type === "wrote") {
    const { path, created, base } = message.details.metadata
    return { path: absolute(path, cwd), created, ...(base === undefined ? {} : { base }) }
  }
  if (message.msgType === "fileEvent" && message.details.type === "edited") {
    return { path: absolute(message.details.path, cwd), created: false }
  }
  return undefined
}

export const collectArtifacts = (
  records: ReadonlyArray<ParsedRecord>,
  cwd: string,
): ReadonlyArray<PotentialArtifact> => {
  // Several transcripts are flattened in, and only the earliest write for a path holds its base.
  const byTime = [...records].sort((a, b) => timeOf(a) - timeOf(b))

  const byPath = new Map<string, PotentialArtifact>()
  for (const message of byTime.flatMap((record) => record.messages)) {
    const artifact = artifactOf(message, cwd)
    if (!artifact) continue
    const seen = byPath.get(artifact.path)
    byPath.set(artifact.path, seen ? mergeArtifact(seen, artifact) : artifact)
  }
  return [...byPath.values()]
}

const HTML_ATTR_REFERENCE = /(?<![\w:-])(?:src|href|poster)\s*=\s*["']([^"']*)["']/gi
const MARKDOWN_REFERENCE = /!?\[[^\]]*\]\(\s*((?:[^()\s]|\([^()]*\))+)/g
const NON_LOCAL_REFERENCE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i

const rawReferencesIn = (content: string): ReadonlyArray<string> =>
  [
    ...[...content.matchAll(HTML_ATTR_REFERENCE)].map((match) => match[1]),
    ...[...content.matchAll(MARKDOWN_REFERENCE)].map((match) => match[1]),
  ].filter((ref): ref is string => ref !== undefined)

const withoutFragmentAndQuery = (ref: string): string =>
  (ref.split("#")[0] ?? "").split("?")[0] ?? ""

const decoded = (ref: string): string => {
  try {
    return decodeURIComponent(ref)
  } catch {
    return ref
  }
}

export const referencedPaths = (content: string, fromDir: string): ReadonlyArray<string> => {
  const seen = new Set<string>()
  const result: string[] = []

  for (const raw of rawReferencesIn(content)) {
    if (NON_LOCAL_REFERENCE.test(raw)) continue
    const local = decoded(withoutFragmentAndQuery(raw))
    if (local.length === 0) continue

    const resolved = absolute(local, fromDir)
    if (seen.has(resolved)) continue
    seen.add(resolved)
    result.push(resolved)
  }

  return result
}
