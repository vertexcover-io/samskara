import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import {
  BASE_REVIEW_INSTRUCTIONS,
  baseReviewVersion,
  contentHash,
  type HarnessRunner,
  mergeReviewPrompt,
  readOr,
} from "@samskara/core"
import { z } from "zod"
import { errorMessage, type Writer } from "../io.js"

/** What was used last time a prompt was merged — the default for the next run. */
const savedSchema = z.object({
  promptPath: z.string(),
  promptHash: z.string(),
  baseVersion: z.string(),
})
type Saved = z.infer<typeof savedSchema>

export type ReviewInstructions =
  | {
      readonly kind: "ready"
      readonly instructions: string
      /** base: ours only. saved: the last merge, reused. merged: merged on this run. */
      readonly source: "base" | "saved" | "merged"
      readonly promptPath?: string
      readonly changes?: string
    }
  | { readonly kind: "error"; readonly message: string }

export type ResolveInstructionsInput = {
  /** A path from --prompt, false from --no-prompt, undefined when neither was given. */
  readonly prompt: string | false | undefined
  readonly cwd: string
  /** Where the saved prompt lives, `~/.samskara/review` in real use. */
  readonly configDir: string
  readonly stderr: Writer
  /** The merge agent. Only called when a prompt is new or has changed. */
  readonly createRunner: () => HarnessRunner
  /** A dry run never calls a model, so a prompt that needs merging falls back to the base. */
  readonly dryRun?: boolean
}

const savedPath = (configDir: string): string => join(configDir, "prompt.json")
const mergedPath = (configDir: string): string => join(configDir, "merged.md")
const changesPath = (configDir: string): string => join(configDir, "changes.md")

const readSaved = async (configDir: string): Promise<Saved | undefined> => {
  const raw = await readOr(savedPath(configDir), null)
  if (raw === null) return undefined
  try {
    const parsed = savedSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

const base = (): ReviewInstructions => ({
  kind: "ready",
  instructions: BASE_REVIEW_INSTRUCTIONS,
  source: "base",
})

/**
 * Decides which review instructions a run uses. With no prompt, ours. With --prompt, the
 * user's file — any shape — merged into ours by an agent, once. The merge is saved together with the
 * hashes it was made from and becomes the default, so later runs reuse the exact same text
 * and only merge again when the user's file or our base has changed.
 */
export const resolveReviewInstructions = async (
  input: ResolveInstructionsInput,
): Promise<ReviewInstructions> => {
  if (input.prompt === false) return base()

  const saved = await readSaved(input.configDir)
  let promptPath: string
  if (input.prompt !== undefined) {
    promptPath = resolve(input.cwd, input.prompt)
  } else {
    if (saved === undefined) return base()
    promptPath = saved.promptPath
  }

  const text = await readOr(promptPath, null)
  if (text === null) {
    // Named on this run: a typo must not quietly review with the default instead.
    if (input.prompt !== undefined)
      return { kind: "error", message: `No prompt file at ${promptPath}.` }
    input.stderr.write(`Your saved prompt ${promptPath} is gone; using the default.\n`)
    return base()
  }
  if (text.trim() === "") return { kind: "error", message: `${promptPath} is empty.` }

  const promptHash = contentHash(text)
  const baseVersion = baseReviewVersion()
  const cached = await readOr(mergedPath(input.configDir), null)
  if (
    saved !== undefined &&
    saved.promptPath === promptPath &&
    saved.promptHash === promptHash &&
    saved.baseVersion === baseVersion &&
    cached !== null
  ) {
    return { kind: "ready", instructions: cached, source: "saved", promptPath }
  }

  if (input.dryRun === true) {
    input.stderr.write(
      "dry run: your prompt needs merging, which calls a model — using the default.\n",
    )
    return base()
  }

  input.stderr.write(
    saved?.promptPath === promptPath && saved.baseVersion !== baseVersion
      ? "Samskara's default prompt changed since your last merge — merging your prompt again.\n"
      : `Merging ${promptPath} into the default prompt…\n`,
  )
  let result: { merged: string; changes: string }
  try {
    result = await mergeReviewPrompt(text, input.createRunner())
  } catch (error) {
    return { kind: "error", message: `Could not merge your prompt: ${errorMessage(error)}` }
  }

  await mkdir(input.configDir, { recursive: true })
  await writeFile(mergedPath(input.configDir), result.merged, "utf8")
  await writeFile(changesPath(input.configDir), `${result.changes}\n`, "utf8")
  const next: Saved = { promptPath, promptHash, baseVersion }
  await writeFile(savedPath(input.configDir), `${JSON.stringify(next, null, 2)}\n`, "utf8")
  return {
    kind: "ready",
    instructions: result.merged,
    source: "merged",
    promptPath,
    changes: result.changes,
  }
}
