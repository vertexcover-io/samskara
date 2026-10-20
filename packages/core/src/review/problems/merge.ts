import type { HarnessRunInput, HarnessRunner } from "../runner.js"
import { BASE_REVIEW_INSTRUCTIONS, buildMergePrompt } from "./contract.js"
import { requiredExtraFields } from "./run.js"
import { withWorkspace } from "./workspace.js"

/** How long a merged prompt may be. A merge is the base plus the user's changes. */
export const MAX_MERGED_CHARS = 60_000

/** The text between `<<<NAME` and `NAME>>>` lines in a reply, or "" when there is none. */
const part = (reply: string, name: string): string =>
  new RegExp(`^<<<${name}\\n([\\s\\S]*?)\\n${name}>>>$`, "m").exec(reply)?.[1]?.trim() ?? ""

/**
 * One call to the model: our base and the user's prompt in, one merged set of review
 * instructions out, plus a short list of what changed. The result is only instructions — the
 * fixed output part is added by code afterwards, so a merge can never change the format.
 */
export const mergeReviewPrompt = async (
  userPrompt: string,
  runner: HarnessRunner,
  /** The same harness and model the review itself runs with. */
  run: Pick<HarnessRunInput, "harness" | "model"> = {},
): Promise<{ merged: string; changes: string }> =>
  // The folder holds nothing: it is only the run's cwd, and its home when sandboxed.
  withWorkspace("samskara-review-merge-", {}, async (workspaceDir) => {
    const { stdout } = await runner.run({
      ...run,
      prompt: buildMergePrompt(BASE_REVIEW_INSTRUCTIONS, userPrompt),
      workspaceDir,
      oneShot: true,
    })
    const merged = part(stdout, "MERGED")
    if (merged === "") throw new Error("the merge did not reply with a merged prompt")
    if (merged.length > MAX_MERGED_CHARS)
      throw new Error(`the merged prompt is longer than ${MAX_MERGED_CHARS} characters`)
    // Checked here so a bad field list fails the merge, not every review that uses it.
    requiredExtraFields(merged)
    return { merged: `${merged}\n`, changes: part(stdout, "CHANGES") }
  })
