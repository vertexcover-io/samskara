// AI-generated. See PROMPT.md for the prompts and model used.

import { detectRepo } from "@claude-sessions/core";
import { readCredentials } from "../config/credentials.js";
import {
  isWatcherAlive,
  resolveCliEntry,
  startWatcherDaemon,
  watchLogPath,
} from "../config/daemon.js";
import { getRepo } from "../config/repos.js";
import { ensureAuthenticated } from "./_pair.js";

const DEFAULT_SERVER_URL = "http://localhost:3000";

export interface EnsureOptions {
  serverUrl?: string;
  /** Working directory to check (defaults to process.cwd()). */
  cwd?: string;
  /** Override the spawned daemon entry point (tests). */
  cliEntry?: string;
  /** Skip starting the daemon (tests). */
  skipDaemon?: boolean;
  /** Inject the watcher-liveness probe (tests). Defaults to `isWatcherAlive`. */
  isWatcherAliveImpl?: () => boolean;
  /** Inject the daemon starter (tests). Defaults to `startWatcherDaemon`. */
  startWatcherDaemonImpl?: typeof startWatcherDaemon;
  fetchImpl?: typeof fetch;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

/** Emit a SessionStart hook payload that injects guidance into the session. */
const emitContext = (stdout: NodeJS.WritableStream, lines: string[]): void => {
  if (lines.length === 0) return;
  stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: lines.join("\n"),
      },
    })}\n`,
  );
};

/**
 * `claude-sessions ensure` — the SessionStart hook entry point. Verifies the
 * CLI is authenticated and the watcher daemon is running, and surfaces a
 * prompt (via the hook's additionalContext) when the cwd repo isn't enabled.
 *
 * Non-interactive and best-effort: it NEVER blocks the session — it always
 * exits 0, degrading to a warning when capture can't be turned on.
 */
export const ensureCommand = async (opts: EnsureOptions = {}): Promise<number> => {
  // Prefer the server the user is actually paired with. The hook installs a
  // bare `claude-sessions ensure`, so opts.serverUrl is just the localhost
  // default — using it for the auth check would falsely report "not
  // authenticated" for anyone paired with a remote server. Stored credentials
  // are authoritative; fall back to the passed/default URL only when unpaired.
  const stored = readCredentials();
  const serverUrl = (stored?.server_url ?? opts.serverUrl ?? DEFAULT_SERVER_URL).replace(
    /\/+$/,
    "",
  );
  const cwd = opts.cwd ?? process.cwd();
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;

  // 1. Auth (non-interactive — never triggers browser pairing).
  const auth = await ensureAuthenticated({
    serverUrl,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  if (!auth) {
    stderr.write("claude-sessions: not authenticated — run `claude-sessions login`\n");
    emitContext(stdout, [
      "Claude-sessions session capture is OFF: the CLI is not authenticated. Tell the user to run `claude-sessions login` to enable capturing this and future sessions.",
    ]);
    return 0;
  }

  // 2. Watcher daemon (detached singleton; returns instantly). This is the
  // autostart path: every Claude Code launch revives the watcher if it died.
  const watcherAlive = opts.isWatcherAliveImpl ?? isWatcherAlive;
  const startDaemon = opts.startWatcherDaemonImpl ?? startWatcherDaemon;
  const watcherContext: string[] = [];
  if (!opts.skipDaemon && !watcherAlive()) {
    try {
      const pid = startDaemon({ cliEntry: opts.cliEntry ?? resolveCliEntry() });
      stderr.write(`claude-sessions: started watcher (pid ${pid}). logs: ${watchLogPath()}\n`);
      // Verify the daemon actually came up — a spawn that returns a pid but
      // dies immediately would otherwise leave capture silently off. Surface
      // it to the agent so the user is told, rather than losing events quietly.
      if (!watcherAlive()) {
        watcherContext.push(
          `Claude-sessions capture may be OFF: the event watcher was started but is not running. Tell the user to check ${watchLogPath()} and restart it with \`claude-sessions watch\`.`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stderr.write(`claude-sessions: failed to start watcher: ${msg}\n`);
      watcherContext.push(
        `Claude-sessions capture is OFF: the event watcher failed to start (${msg}). This session's logs will not be saved until it is running.`,
      );
    }
  }

  // 3. Is the current repo enabled for capture?
  const context: string[] = [...watcherContext];
  const id = detectRepo(cwd);
  if (id) {
    const entry = getRepo(id.canonical_url);
    if (!entry || !entry.enabled) {
      context.push(
        `This repository (${id.canonical_url}) is not enabled for claude-sessions capture, so this session will not be saved. Ask the user whether to enable capture for this repo; if they agree, run \`claude-sessions enable\`.`,
      );
    } else {
      context.push(
        "Claude-sessions capture is active for this repo. After completing any significant task (a feature, fix, or refactor — not every small edit), author and push a session summary with `claude-sessions summarize --current --from-agent`. Use the `claude-session` skill to learn how to write the summary JSON and how this tool works (summaries, artifacts, commands).",
      );
    }
  }
  emitContext(stdout, context);
  return 0;
};
