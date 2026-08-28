import { isAbsolute, resolve } from "node:path"
import type { ParsedRecord } from "@samskara/core"
import { z } from "zod"

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

const agentWrite = z.object({
  timestamp: z.string().datetime({ offset: true }),
  toolUseResult: z.object({
    filePath: z.string().min(1),
    type: z.enum(["create", "update"]).optional(),
    originalFile: z.string().nullish(),
  }),
})

const humanEdit = z.object({
  attachment: z.object({
    type: z.literal("edited_text_file"),
    filename: z.string().min(1),
  }),
})

const blank = (path: string): PotentialArtifact => ({ path, created: false })

const timeOf = (record: ParsedRecord): number => {
  const stamp = (record.raw as { timestamp?: unknown }).timestamp
  return typeof stamp === "string" ? Date.parse(stamp) : 0
}

export const collectArtifacts = (
  records: ReadonlyArray<ParsedRecord>,
  cwd: string,
): ReadonlyArray<PotentialArtifact> => {
  const byPath = new Map<string, PotentialArtifact>()

  // Several transcripts are flattened in, and only the earliest write for a path holds its base.
  const byTime = [...records].sort((a, b) => timeOf(a) - timeOf(b))

  for (const record of byTime) {
    const human = humanEdit.safeParse(record.raw)
    if (human.success) {
      const path = absolute(human.data.attachment.filename, cwd)
      byPath.set(path, byPath.get(path) ?? blank(path))
      continue
    }

    const agent = agentWrite.safeParse(record.raw)
    if (!agent.success) continue

    const { filePath, type, originalFile } = agent.data.toolUseResult
    const path = absolute(filePath, cwd)

    byPath.set(
      path,
      mergeArtifact(byPath.get(path) ?? blank(path), {
        path,
        created: type === "create",
        base: originalFile ?? undefined,
      }),
    )
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
