// AI-generated. See PROMPT.md for the prompts and model used.

import { reviveWatcher } from "../config/daemon.js";
import { HttpError, type UploadClient } from "../upload/client.js";

/**
 * `claude-sessions prompt-hook` — the UserPromptSubmit-hook entry point that
 * gives a brand-new session a readable title as soon as the user sends their
 * first prompt, instead of leaving it as `Session <id>` in the dashboard.
 *
 * Claude Code invokes this with the UserPromptSubmit payload on stdin, BEFORE
 * the prompt is processed (blocking, 30s timeout) — so the hook does almost
 * nothing: one fast `getSession` probe. When the session has no `ok` summary
 * yet, we inject a one-time instruction (via `hookSpecificOutput.additionalContext`)
 * telling the in-loop agent to author a provisional summary itself. The hook
 * never runs `summarize`.
 *
 * Contract (https://code.claude.com/docs/en/hooks): on exit 0, stdout is parsed
 * as JSON; `hookSpecificOutput.additionalContext` is wrapped in a system
 * reminder for the agent. Any uncertainty (malformed input, missing session,
 * server down) emits nothing and exits 0 — the hook must never block a turn.
 */

export interface PromptHookOptions {
  client: UploadClient;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  /** Inject the watcher-revive (tests). Defaults to `reviveWatcher`. */
  reviveWatcherImpl?: () => number | null;
}

interface PromptHookInput {
  session_id?: string;
  transcript_path?: string;
  prompt?: string;
}

const PROVISIONAL_INSTRUCTION =
  "[claude-sessions] This session has no title yet. As your FIRST action, before " +
  "starting the user's task, author a provisional summary derived ONLY from the " +
  "user's request so the dashboard shows a readable title instead of `Session <id>`. " +
  "Run `claude-sessions summarize --current --from-agent --provisional` and pipe a " +
  'JSON object on stdin: {"title": "<short, ≤80 chars>", "summary": "<one ' +
  'sentence describing the request>", "tags": ["<2-5 kebab-case topics>"], ' +
  '"files_touched": [], "prs_referenced": []}. The claude-session skill documents ' +
  "the contract. This is quick and only needs doing once; then proceed with the " +
  "task normally. A richer summary is captured automatically when the session ends.";

const readStdin = async (stdin: NodeJS.ReadableStream): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
};

export const promptHookCommand = async (opts: PromptHookOptions): Promise<number> => {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;

  // Revive the watcher if it died — every hook boundary is a chance to recover,
  // not just SessionStart. Fail-open: a spawn failure must never block the turn.
  try {
    (opts.reviveWatcherImpl ?? reviveWatcher)();
  } catch {
    // ignore — capture reliability must not compromise the user's turn.
  }

  let input: PromptHookInput;
  try {
    const raw = await readStdin(stdin);
    input = raw ? (JSON.parse(raw) as PromptHookInput) : {};
  } catch {
    return 0;
  }

  const sessionId = input.session_id;
  if (!sessionId) return 0;

  // Does the session already have a usable title? Probe the server.
  let hasSummary: boolean;
  try {
    const detail = await opts.client.getSession(sessionId);
    hasSummary = detail.summary?.status === "ok";
  } catch (err) {
    // 404 means the session isn't on the server yet — a brand-new session
    // that definitely has no title, so inject. Any other error (server down,
    // network) fails open: don't nag.
    if (err instanceof HttpError && err.status === 404) {
      hasSummary = false;
    } else {
      return 0;
    }
  }

  // A provisional or real summary already exists — nothing to do.
  if (hasSummary) return 0;

  stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: PROVISIONAL_INSTRUCTION,
      },
    })}\n`,
  );
  return 0;
};
