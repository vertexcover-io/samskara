// AI-generated. See PROMPT.md for the prompts and model used.

import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { findGitRoot } from "@claude-sessions/core";

/**
 * Where Claude Code stores per-cwd JSONL transcripts. Override via the
 * `CLAUDE_PROJECTS_DIR` env var so tests don't scrub the user's real
 * `~/.claude/projects/`.
 */
export const claudeProjectsRoot = (): string =>
  process.env.CLAUDE_PROJECTS_DIR ?? join(homedir(), ".claude", "projects");

/**
 * Claude Code names project directories by replacing `/` with `-` in the
 * cwd. Used as a coarse glob; the source of truth is each JSONL's first
 * line `cwd` field, which we validate before claiming a file.
 */
const encodeCwd = (path: string): string => path.replace(/\//g, "-");

/**
 * Read the first JSONL records from `path` until we find one that carries a
 * string `cwd` field. Newer Claude Code transcripts prepend meta records
 * (`last-prompt`, `permission-mode`, …) without `cwd`; the source-of-truth
 * cwd lives a few lines in. We read up to 64 KiB and scan up to 32 records
 * before giving up.
 */
const readSessionAnchorLine = (path: string): Record<string, unknown> | null => {
  try {
    const buf = Buffer.alloc(64 * 1024);
    const fd = openSync(path, "r");
    let bytes: number;
    try {
      bytes = readSync(fd, buf, 0, buf.length, 0);
    } finally {
      closeSync(fd);
    }
    const text = buf.subarray(0, bytes).toString("utf8");
    const lines = text.split("\n");
    let firstParsed: Record<string, unknown> | null = null;
    let scanned = 0;
    for (const raw of lines) {
      if (scanned >= 32) break;
      const line = raw.trim();
      if (!line) continue;
      scanned += 1;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (firstParsed === null) firstParsed = parsed;
      if (typeof parsed.cwd === "string") return parsed;
    }
    return firstParsed;
  } catch {
    return null;
  }
};

export interface DiscoveredFile {
  path: string;
  cwd: string;
  session_id: string | null;
}

const listJsonlInDir = (dir: string): string[] => {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    const full = join(dir, name);
    try {
      if (statSync(full).isFile()) out.push(full);
    } catch {
      // ignore
    }
  }
  return out;
};

/**
 * Find every JSONL whose `cwd` matches one of the repo's local paths.
 *
 * Two passes: (1) glob the encoded-cwd directory under
 * `~/.claude/projects/` (cheap), (2) walk every project dir and validate
 * by reading the first line. The second pass catches edge cases where
 * the user moved a worktree or Claude rewrote the directory name.
 */
export const findSessionsForRepo = (
  _canonicalUrl: string,
  localPaths: string[],
): DiscoveredFile[] => {
  const root = claudeProjectsRoot();
  if (!existsSync(root)) return [];

  const candidates = new Set<string>();
  for (const p of localPaths) {
    const dir = join(root, encodeCwd(p));
    for (const f of listJsonlInDir(dir)) candidates.add(f);
  }

  for (const sub of readdirSync(root)) {
    const subDir = join(root, sub);
    let isDir = false;
    try {
      isDir = statSync(subDir).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    for (const f of listJsonlInDir(subDir)) candidates.add(f);
  }

  const results: DiscoveredFile[] = [];
  for (const path of candidates) {
    const anchor = readSessionAnchorLine(path);
    if (!anchor) continue;
    const cwdRaw = anchor.cwd;
    const cwd = typeof cwdRaw === "string" ? cwdRaw : null;
    if (!cwd) continue;
    // A session's cwd is often a subdirectory or worktree of the repo, not the
    // registered toplevel. Match by exact path first (cheap), then fall back to
    // resolving the cwd's git toplevel (pure filesystem) and checking that.
    // Without this, subdir sessions are never discovered — so `sync --verify`
    // can't even find them to reconcile.
    const belongs = localPaths.includes(cwd) || localPaths.includes(findGitRoot(cwd) ?? "\0");
    if (!belongs) continue;
    const sidRaw = anchor.sessionId;
    const session_id = typeof sidRaw === "string" ? sidRaw : null;
    results.push({ path, cwd, session_id });
  }
  return results;
};

/**
 * Read the first JSONL line for session metadata — used by the watcher
 * to decide whether a file belongs to an enabled repo (EDGE-005).
 */
export const readSessionMeta = (
  path: string,
): { session_id: string | null; cwd: string | null } => {
  const anchor = readSessionAnchorLine(path);
  if (!anchor) return { session_id: null, cwd: null };
  const cwdRaw = anchor.cwd;
  const cwd = typeof cwdRaw === "string" ? cwdRaw : null;
  const sidRaw = anchor.sessionId;
  const session_id = typeof sidRaw === "string" ? sidRaw : null;
  return { session_id, cwd };
};

export const _internal = { encodeCwd, readSessionAnchorLine };
