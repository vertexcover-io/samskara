import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import type { HarnessRunner } from "../runner.js"
import { BASE_REVIEW_INSTRUCTIONS } from "./contract.js"
import { MAX_MERGED_CHARS, mergeReviewPrompt } from "./merge.js"

const agent = (write: (dir: string) => Promise<void>): HarnessRunner => ({
  run: async ({ workspaceDir }) => {
    await write(workspaceDir)
    return { stdout: "done", firstByteMs: 1 }
  },
})

describe("mergeReviewPrompt", () => {
  test("MG1: the agent sees our base and the user's prompt, and its MERGED.md and CHANGES.md come back", async () => {
    let seen: { base: string; user: string } | undefined
    const result = await mergeReviewPrompt(
      "Ignore gaps under 10 minutes.",
      agent(async (dir) => {
        seen = {
          base: await readFile(join(dir, "BASE.md"), "utf8"),
          user: await readFile(join(dir, "USER.md"), "utf8"),
        }
        await writeFile(join(dir, "MERGED.md"), "# How to review\n\nmerged")
        await writeFile(join(dir, "CHANGES.md"), "- Changed Step 1: gaps over 10 minutes\n")
      }),
    )
    expect(seen).toEqual({ base: BASE_REVIEW_INSTRUCTIONS, user: "Ignore gaps under 10 minutes." })
    expect(result).toEqual({
      merged: "# How to review\n\nmerged\n",
      changes: "- Changed Step 1: gaps over 10 minutes",
    })
  })

  test("MG2: no MERGED.md, or one past the size limit, is an error", async () => {
    await expect(
      mergeReviewPrompt(
        "x",
        agent(async () => undefined),
      ),
    ).rejects.toThrow("did not write MERGED.md")
    await expect(
      mergeReviewPrompt(
        "x",
        agent((dir) => writeFile(join(dir, "MERGED.md"), "y".repeat(MAX_MERGED_CHARS + 1))),
      ),
    ).rejects.toThrow("longer than")
  })

  test("MG3: a merge whose Extra fields are not simple names fails, rather than dropping every problem later", async () => {
    await expect(
      mergeReviewPrompt(
        "x",
        agent((dir) =>
          writeFile(
            join(dir, "MERGED.md"),
            "# How\n\n## Extra fields\n\n- the stage it was in: x\n",
          ),
        ),
      ),
    ).rejects.toThrow("not a field name")
  })
})
