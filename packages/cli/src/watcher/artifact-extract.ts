import { isAbsolute, resolve } from "node:path"
import type { NormalizedMessage, ParsedRecord } from "@samskara/core"
import type pino from "pino"
import { z } from "zod"

export type PotentialArtifact = {
  readonly path: string
  readonly origin: "toolCall" | "fileEvent"
  readonly changeKind: "created" | "edited"
  readonly oldFragment?: string
  readonly backupFileName?: string
}

const filePath = z.string().min(1)

const writeInput = z.object({ file_path: filePath })
const editInput = z.object({ file_path: filePath, old_string: z.string().optional() })
const multiEditInput = z.object({
  file_path: filePath,
  edits: z.array(z.object({ old_string: z.string().optional() })).optional(),
})
const notebookEditInput = z.object({ notebook_path: filePath })
const deltaBackup = z.object({ backupFileName: z.string().nullable().optional() })

type Write = { readonly path: string; readonly oldFragment?: string }

/**
 * `Read` is deliberately absent: this is "artifacts the agent produced", not "files it touched".
 * Widening this map to every tool would silently capture everything the agent looked at.
 */
const WRITE_FAMILY: Record<string, (input: unknown) => ReadonlyArray<Write>> = {
  Write: (input) => {
    const parsed = writeInput.safeParse(input)
    return parsed.success ? [{ path: parsed.data.file_path }] : []
  },
  Edit: (input) => {
    const parsed = editInput.safeParse(input)
    if (!parsed.success) return []
    const { file_path, old_string } = parsed.data
    return [{ path: file_path, ...(old_string === undefined ? {} : { oldFragment: old_string }) }]
  },
  MultiEdit: (input) => {
    const parsed = multiEditInput.safeParse(input)
    if (!parsed.success) return []
    const { file_path, edits } = parsed.data
    return (edits ?? [{}]).map((edit) => ({
      path: file_path,
      ...(edit.old_string === undefined ? {} : { oldFragment: edit.old_string }),
    }))
  },
  NotebookEdit: (input) => {
    const parsed = notebookEditInput.safeParse(input)
    return parsed.success ? [{ path: parsed.data.notebook_path }] : []
  },
}

const CREATED_BY = "Write"

const absolute = (path: string, cwd: string): string =>
  isAbsolute(path) ? path : resolve(cwd, path)

/**
 * One fact drawn from a single message. A `write` is evidence the agent produced a file; a `backup`
 * only points at where its pre-session content lives and never implies a write of its own -- which
 * is why the two are separate variants rather than one partially-filled candidate.
 */
type ExtractedFact =
  | { readonly kind: "write"; readonly candidate: PotentialArtifact }
  | { readonly kind: "backup"; readonly path: string; readonly backupFileName?: string }

const fromToolCall = (
  message: Extract<NormalizedMessage, { msgType: "toolCall" }>,
  cwd: string,
  log: pino.Logger,
): ReadonlyArray<ExtractedFact> => {
  const project = WRITE_FAMILY[message.details.name]
  if (!project) return []

  const writes = project(message.details.input)
  if (writes.length === 0) {
    log.debug({ tool: message.details.name }, "artifact tool input did not parse; skipping")
    return []
  }

  const changeKind = message.details.name === CREATED_BY ? "created" : "edited"
  return writes.map((write) => ({
    kind: "write" as const,
    candidate: {
      path: absolute(write.path, cwd),
      origin: "toolCall" as const,
      changeKind,
      ...(write.oldFragment === undefined ? {} : { oldFragment: write.oldFragment }),
    },
  }))
}

const fromFileEvent = (
  message: Extract<NormalizedMessage, { msgType: "fileEvent" }>,
  cwd: string,
): ReadonlyArray<ExtractedFact> => {
  const { details } = message
  if (details.type === "edited") {
    return [
      {
        kind: "write",
        candidate: { path: absolute(details.path, cwd), origin: "fileEvent", changeKind: "edited" },
      },
    ]
  }
  if (details.type !== "delta") return []

  // A delta is a base pointer, not evidence of a write, so it never creates a candidate.
  const backup = deltaBackup.safeParse(details.backup)
  const name = backup.success ? backup.data.backupFileName : undefined
  return [
    {
      kind: "backup",
      path: absolute(details.path, cwd),
      ...(name === undefined || name === null ? {} : { backupFileName: name }),
    },
  ]
}

const factsOf = (
  message: NormalizedMessage,
  cwd: string,
  log: pino.Logger,
): ReadonlyArray<ExtractedFact> => {
  if (message.msgType === "toolCall") return fromToolCall(message, cwd, log)
  if (message.msgType === "fileEvent") return fromFileEvent(message, cwd)
  return []
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

    const resolved = resolve(fromDir, local)
    if (seen.has(resolved)) continue
    seen.add(resolved)
    result.push(resolved)
  }

  return result
}

export const collectArtifacts = (
  records: ReadonlyArray<ParsedRecord>,
  cwd: string,
  log: pino.Logger,
): ReadonlyArray<PotentialArtifact> => {
  const facts = records.flatMap((record) =>
    record.messages.flatMap((message) => factsOf(message, cwd, log)),
  )

  const candidates = new Map<string, PotentialArtifact>()
  for (const fact of facts) {
    if (fact.kind === "write") {
      const existing = candidates.get(fact.candidate.path)
      candidates.set(fact.candidate.path, { ...existing, ...fact.candidate })
      continue
    }
    const existing = candidates.get(fact.path)
    if (!existing || fact.backupFileName === undefined) continue
    candidates.set(fact.path, {
      ...existing,
      backupFileName: fact.backupFileName,
    })
  }
  return [...candidates.values()]
}
