import {
  createClaudeRunner,
  createMsbWrappedRunner,
  createOpencodeRunner,
  type HarnessRunner,
  type ReviewHarness,
} from "@samskara/core"
import type pino from "pino"
import type { Env } from "../../lib/env.js"

/**
 * Build the production AI-review runner. Which CLI runs the reviewer is a per-run choice
 * (the modal posts `harness` with the analyze request; the pipeline resolves it against the
 * env default), so this builds both lanes once and dispatches on each call:
 *
 * - `opencode` is hard-sandboxed — it runs inside a microsandbox (libkrun microVM) via the
 *   `msb` CLI, with no view of the host filesystem except the bind mounts we hand it, so a
 *   reviewer cannot reach the user's real opencode db or any other session state.
 *   `AI_REVIEW_HARDEN=0` falls back to the in-process runner used in tests.
 * - `claude` always uses the in-process runner (Claude Code reads its credentials from
 *   CLAUDE_CONFIG_DIR, which the runner redirects into the workspace — the msb bootstrap
 *   only knows how to npm-install opencode, so a claude-in-microVM image is separate
 *   future work). `AI_REVIEW_CLAUDE_SANDBOX=0` drops that redirect and runs the reviewer
 *   under the server's own HOME, the only way it can reach a macOS Keychain login; it also
 *   lets the reviewer read the session under review directly, so prefer `claude
 *   setup-token` + `CLAUDE_CODE_OAUTH_TOKEN` and keep the sandbox.
 */
export const defaultAiReviewRunner = (env: Env, log: pino.Logger): HarnessRunner => {
  const claude = createClaudeRunner({
    model: env.aiReviewModel,
    timeoutMs: env.aiReviewTimeoutMs,
    log: log.child({ component: "ai-review", harness: "claude" }),
    ...(process.env.AI_REVIEW_CLAUDE_SANDBOX === "0" ? { sandboxHome: false } : {}),
  })
  const opencode: HarnessRunner =
    process.env.AI_REVIEW_HARDEN === "0"
      ? createOpencodeRunner({
          model: env.aiReviewModel,
          timeoutMs: env.aiReviewTimeoutMs,
          log: log.child({ component: "ai-review", sandbox: "soft" }),
        })
      : createMsbWrappedRunner({
          model: env.aiReviewModel,
          timeoutMs: env.aiReviewTimeoutMs,
          log: log.child({ component: "ai-review", sandbox: "msb" }),
          ...(process.env.AI_REVIEW_IMAGE !== undefined
            ? { image: process.env.AI_REVIEW_IMAGE }
            : {}),
          ...(process.env.AI_REVIEW_SNAPSHOT !== undefined
            ? { msbSnapshot: process.env.AI_REVIEW_SNAPSHOT }
            : {}),
          ...(process.env.AI_REVIEW_MEMORY_MB !== undefined
            ? { memoryMb: Number.parseInt(process.env.AI_REVIEW_MEMORY_MB, 10) }
            : {}),
        })
  return {
    run: (input) => {
      const byHarness: Readonly<Record<ReviewHarness, HarnessRunner>> = { opencode, claude }
      const chosen: HarnessRunner = byHarness[input.harness ?? env.aiReviewHarness]
      return chosen.run(input)
    },
  }
}
