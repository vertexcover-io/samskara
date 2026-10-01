import { join } from "node:path"
import type { HarnessRunInput, HarnessRunner } from "../runner.js"
import { BASE_REVIEW_INSTRUCTIONS, buildMergePrompt } from "./contract.js"
import { requiredExtraFields } from "./run.js"
import { readOr, withWorkspace } from "./workspace.js"

/** How long a merged prompt may be. A merge is the base plus the user's changes. */
export const MAX_MERGED_CHARS = 60_000

/**
 * One run of the merge agent: our base and the user's prompt in, one merged set of review
 * instructions out, plus a short list of what changed. The result is only instructions — the
 * fixed output part is added by code afterwards, so a merge can never change the format.
 */
export const mergeReviewPrompt = async (
  userPrompt: string,
  runner: HarnessRunner,
  /** The same harness and model the review itself runs with. */
  run: Pick<HarnessRunInput, "harness" | "model"> = {},
): Promise<{ merged: string; changes: string }> =>
  withWorkspace(
    "samskara-review-merge-",
    { "BASE.md": BASE_REVIEW_INSTRUCTIONS, "USER.md": userPrompt },
    async (workspaceDir) => {
      await runner.run({ ...run, prompt: buildMergePrompt(), workspaceDir })
      const merged = (await readOr(join(workspaceDir, "MERGED.md"))).trim()
      if (merged === "") throw new Error("the merge agent did not write MERGED.md")
      if (merged.length > MAX_MERGED_CHARS)
        throw new Error(`the merged prompt is longer than ${MAX_MERGED_CHARS} characters`)
      // Checked here so a bad field list fails the merge, not every review that uses it.
      requiredExtraFields(merged)
      const changes = (await readOr(join(workspaceDir, "CHANGES.md"))).trim()
      return { merged: `${merged}\n`, changes }
    },
  )
