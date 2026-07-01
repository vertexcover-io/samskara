// AI-generated. See PROMPT.md for the prompts and model used.

import { existsSync } from "node:fs";
import { readSessionSync } from "@claude-sessions/adapter-claude";
import type { CanonicalSession } from "@claude-sessions/core";
import { reviveWatcher } from "../config/daemon.js";
import { type SettingsFile, readSettings } from "../config/settings.js";
import { readWatermark } from "../summarizer/index.js";
import { detectSignals, renderSignalAnchors } from "../summarizer/signals.js";
import type { UploadClient } from "../upload/client.js";

/**
 * `claude-sessions stop-hook` — the Stop-hook entry point that makes the
 * in-loop agent author its own session summary before the turn ends.
 *
 * Claude Code invokes this with the Stop hook payload on stdin. When the
 * session is substantive and has no fresh summary yet, we emit a
 * `decision: "block"` so the agent is prompted to run
 * `summarize --current --from-agent`. `claude -p` stays a manual last resort.
 *
 * Contract (https://code.claude.com/docs/en/hooks): printing
 * `{"decision":"block","reason":...}` on stdout with exit 0 continues the
 * turn and feeds `reason` back to the agent. `stop_hook_active` is true once
 * we've already blocked this cycle — we must allow the stop then, or loop.
 * Any uncertainty (malformed input, unknown session, server error) allows
 * the stop: the hook must never wedge a session shut.
 */

export const DEFAULT_MIN_EVENTS = 10;

/**
 * Freshness margin for the nag decision. Authoring a summary is self-defeating
 * under the shared 5-event re-summarize delta: the `Bash` tool_use that runs
 * `summarize`, its tool_result, the turn's closing assistant message and the
 * injected block reason all land in the transcript *after* the pipeline stamps
 * `summarized_event_count`, so the next Stop sees a ~5-6 event delta from the
 * round-trip alone and judges the just-authored summary stale — nagging forever.
 * Keep this comfortably above the round-trip footprint so only genuinely new
 * work re-triggers the nag. (The Summarizer's re-summarize gate is a separate
 * concern and keeps the 5-event default.)
 */
export const DEFAULT_FRESH_DELTA = 12;

export interface StopHookOptions {
  client: UploadClient;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  /** Minimum transcript events before we bother nagging. */
  minEvents?: number;
  /** New-event threshold below which an existing summary counts as fresh. */
  minDelta?: number;
  /** Inject a session reader (tests). Defaults to `readSessionSync`. */
  readSession?: (path: string) => CanonicalSession;
  /** Inject the watermark probe (tests). */
  readWatermarkImpl?: typeof readWatermark;
  /** Inject persistent settings (tests). Defaults to `readSettings()`. */
  readSettingsImpl?: () => SettingsFile;
  /** Inject the watcher-revive (tests). Defaults to `reviveWatcher`. */
  reviveWatcherImpl?: () => number | null;
}

interface StopHookInput {
  session_id?: string;
  transcript_path?: string;
  stop_hook_active?: boolean;
}

const SUMMARY_REASON_BASE =
  "Author a summary of this session and push it before stopping. Run " +
  "`claude-sessions summarize --current --from-agent` and pipe a JSON object on stdin with these " +
  'keys: {"title": "<short, ≤80 chars>", "summary": "<2-4 sentences on what was done>", ' +
  '"tags": ["<2-5 kebab-case topics>"], "files_touched": ["<repo-relative paths you changed>"], ' +
  '"prs_referenced": ["<PR URLs or numbers, or []>"]}. See the claude-session skill for the full ' +
  "schema.";

const SUMMARY_REASON_LEARNINGS =
  " If this session had failure episodes (a user correction, a tool/test failure, a reopened " +
  "task, a revert), include a `learnings` array: one evidence-anchored record per episode, each " +
  "citing ≥1 event_uuid, with descriptive `what_went_wrong` / `what_would_have_prevented` prose, " +
  "a `root_cause`, `attributed_to`, and `confidence`. Use `[]` when the session was clean.";

const readStdin = async (stdin: NodeJS.ReadableStream): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
};

export const stopHookCommand = async (opts: StopHookOptions): Promise<number> => {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const minEvents = opts.minEvents ?? DEFAULT_MIN_EVENTS;
  const minDelta = opts.minDelta ?? DEFAULT_FRESH_DELTA;

  // Revive the watcher before anything else — independent of the summary gate
  // (a dead watcher must be recovered even when summaries are disabled) and
  // fail-open so it can never wedge the stop.
  try {
    (opts.reviveWatcherImpl ?? reviveWatcher)();
  } catch {
    // ignore — never block the stop on capture-daemon housekeeping.
  }

  let input: StopHookInput;
  try {
    const raw = await readStdin(stdin);
    input = raw ? (JSON.parse(raw) as StopHookInput) : {};
  } catch {
    return 0;
  }

  // Loop guard: we already blocked once this stop cycle — let it stop now.
  if (input.stop_hook_active) return 0;

  // Summary disabled by the user — never nag. The watcher still tails/uploads
  // events; only the automatic summary authoring trigger is suppressed.
  const settings = (opts.readSettingsImpl ?? readSettings)();
  if (!settings.summary_enabled) return 0;

  const sessionId = input.session_id;
  const transcriptPath = input.transcript_path;
  if (!sessionId || !transcriptPath || !existsSync(transcriptPath)) return 0;

  // Activity threshold: trivial sessions aren't worth a summary.
  let session: CanonicalSession;
  try {
    session = (opts.readSession ?? readSessionSync)(transcriptPath);
  } catch {
    return 0;
  }
  if (session.events.length < minEvents) return 0;

  // A fresh summary already exists (e.g. the agent just pushed one, or we
  // blocked a moment ago) — allow the stop.
  try {
    const wm = await (opts.readWatermarkImpl ?? readWatermark)(sessionId, transcriptPath, {
      upload: opts.client,
      ...(opts.readSession ? { readSession: opts.readSession } : {}),
      minDelta,
    });
    if (wm.fresh) return 0;
  } catch {
    // Unknown session (404) or server error — pushing would fail too, so
    // there's nothing to gain by blocking. Allow the stop.
    return 0;
  }

  // Stage-1 signal detection: hand the agent deterministic evidence anchors
  // (computed over the full JSONL) so long sessions stay diagnosable. Fail
  // open — a detector hiccup must never wedge the session shut. Skipped
  // entirely when learnings are disabled (no per-turn signal compute, and the
  // agent is not asked for a `learnings` array).
  let reason = SUMMARY_REASON_BASE;
  if (settings.learnings_enabled) {
    reason += SUMMARY_REASON_LEARNINGS;
    try {
      reason += renderSignalAnchors(detectSignals(session));
    } catch {
      // ignore — keep the base reason.
    }
  }

  stdout.write(`${JSON.stringify({ decision: "block", reason })}\n`);
  return 0;
};
