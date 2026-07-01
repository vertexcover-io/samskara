// AI-generated. See PROMPT.md for the prompts and model used.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { configHome } from "./paths.js";

/** Absolute path to the CLI's own `main.js`, so a spawned daemon (or a hook
 *  command) never depends on `claude-sessions` being on PATH at runtime. */
export const resolveCliEntry = (): string => fileURLToPath(new URL("../main.js", import.meta.url));

export const watchPidPath = (): string => join(configHome(), "watch.pid");
export const watchLogPath = (): string => join(configHome(), "watch.log");

const ensureDir = (file: string): void => {
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
};

const readPid = (): number | null => {
  const path = watchPidPath();
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8").trim();
  const pid = Number.parseInt(raw, 10);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
};

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export const watcherPid = (): number | null => {
  const pid = readPid();
  if (pid === null) return null;
  if (!isProcessAlive(pid)) {
    try {
      unlinkSync(watchPidPath());
    } catch {
      // ignore
    }
    return null;
  }
  return pid;
};

export const isWatcherAlive = (): boolean => watcherPid() !== null;

export interface StartDaemonOptions {
  /** Path to the CLI's main.js (resolved by caller). */
  cliEntry: string;
  /** Override node binary (tests). */
  nodeBin?: string;
}

export const startWatcherDaemon = (opts: StartDaemonOptions): number => {
  const existing = watcherPid();
  if (existing !== null) return existing;
  const logPath = watchLogPath();
  const pidPath = watchPidPath();
  ensureDir(logPath);
  const out = openSync(logPath, "a");
  const err = openSync(logPath, "a");
  const child = spawn(opts.nodeBin ?? process.execPath, [opts.cliEntry, "watch"], {
    detached: true,
    stdio: ["ignore", out, err],
    env: { ...process.env, CLAUDE_SESSIONS_HOME: configHome() },
  });
  child.unref();
  if (!child.pid) throw new Error("failed to spawn watcher daemon");
  writeFileSync(pidPath, String(child.pid), { mode: 0o600 });
  return child.pid;
};

export const stopWatcherDaemon = (timeoutMs = 5000): boolean => {
  const pid = watcherPid();
  if (pid === null) return false;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // already dead
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  if (isProcessAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // ignore
    }
  }
  try {
    unlinkSync(watchPidPath());
  } catch {
    // ignore
  }
  return true;
};

/**
 * Ensure a watcher daemon is running — the single revive primitive shared by
 * `ensure` (SessionStart) and the prompt/stop hooks. Cheap and fail-open: a
 * PID-file liveness probe, and a detached spawn only if the watcher is dead.
 * Returns the live PID, or null if start failed (callers must not block on it).
 * Only SessionStart used to revive the watcher; wiring this into every hook
 * boundary means a mid-session crash is recovered at the next prompt/stop
 * instead of leaving the rest of the session uncaptured.
 */
export const reviveWatcher = (opts: { cliEntry?: string } = {}): number | null => {
  const existing = watcherPid();
  if (existing !== null) return existing;
  try {
    return startWatcherDaemon({ cliEntry: opts.cliEntry ?? resolveCliEntry() });
  } catch {
    return null;
  }
};
