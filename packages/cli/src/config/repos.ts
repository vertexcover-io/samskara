// AI-generated. See PROMPT.md for the prompts and model used.

import { detectRepo, findGitRoot } from "@claude-sessions/core";
import { atomicWriteJson, readJsonOr, withFileLock } from "./atomic.js";
import { reposPath } from "./paths.js";

export interface RepoEntry {
  local_path: string;
  enabled: boolean;
  manual_override_url: string | null;
  enabled_at: string;
}

export interface ReposFile {
  version: 1;
  repos: Record<string, RepoEntry>;
}

const empty = (): ReposFile => ({ version: 1, repos: {} });

const readAll = (): ReposFile => {
  const raw = readJsonOr<ReposFile | null>(reposPath(), null);
  if (!raw || raw.version !== 1 || typeof raw.repos !== "object" || raw.repos === null) {
    return empty();
  }
  return raw;
};

export const getRepo = (canonicalUrl: string): RepoEntry | null => {
  const all = readAll();
  return all.repos[canonicalUrl] ?? null;
};

export const upsertRepo = async (
  canonicalUrl: string,
  patch: Partial<RepoEntry> & { local_path: string },
): Promise<RepoEntry> => {
  let result!: RepoEntry;
  await withFileLock(reposPath(), () => {
    const all = readAll();
    const existing = all.repos[canonicalUrl];
    const next: RepoEntry = {
      local_path: patch.local_path,
      enabled: patch.enabled ?? existing?.enabled ?? true,
      manual_override_url: patch.manual_override_url ?? existing?.manual_override_url ?? null,
      enabled_at:
        patch.enabled === false
          ? (existing?.enabled_at ?? new Date().toISOString())
          : new Date().toISOString(),
    };
    all.repos[canonicalUrl] = next;
    atomicWriteJson(reposPath(), all);
    result = next;
  });
  return result;
};

export const setEnabled = async (
  canonicalUrl: string,
  enabled: boolean,
): Promise<RepoEntry | null> => {
  let result: RepoEntry | null = null;
  await withFileLock(reposPath(), () => {
    const all = readAll();
    const existing = all.repos[canonicalUrl];
    if (!existing) return;
    const next: RepoEntry = { ...existing, enabled };
    all.repos[canonicalUrl] = next;
    atomicWriteJson(reposPath(), all);
    result = next;
  });
  return result;
};

export const listRepos = (): Array<{ canonical_url: string; entry: RepoEntry }> => {
  const all = readAll();
  return Object.entries(all.repos).map(([canonical_url, entry]) => ({ canonical_url, entry }));
};

export const findRepoByLocalPath = (
  path: string,
): { canonical_url: string; entry: RepoEntry } | null => {
  for (const r of listRepos()) {
    if (r.entry.local_path === path) return r;
  }
  return null;
};

export interface ResolvedRepo {
  canonical_url: string;
  entry: RepoEntry;
  /**
   * The canonical URL the cwd actually resolves to via git. Usually equals
   * `canonical_url`, but for a same-remote clone under a different path it is
   * what `detectRepo` reported — the authoritative value to ship on ingest.
   */
  resolved_url: string;
}

// A session's cwd is wherever Claude was launched — often a subdirectory, a
// git worktree, or a renamed/temp clone, none of which equal the registered
// git-toplevel `local_path`. Matching by exact path silently drops those
// sessions. detectRepo() shells out to git, so memoize per cwd for the life of
// the process (the watcher re-checks the same handful of cwds every tick).
const cwdRepoCache = new Map<string, ResolvedRepo | null>();

/**
 * Resolve a session cwd to the enabled repo it belongs to, by git identity
 * rather than path equality. Fast path first (exact match, then a pure-fs
 * `findGitRoot` toplevel match — no shell); only then fall back to
 * `detectRepo(cwd)` and match on canonical URL, which also catches same-remote
 * clones under a different path. Scoped to ENABLED repos so we never capture a
 * repo the user didn't opt into. Returns null when the cwd maps to no enabled
 * repo.
 */
export const resolveEnabledRepoForCwd = (cwd: string): ResolvedRepo | null => {
  const cached = cwdRepoCache.get(cwd);
  if (cached !== undefined) return cached;

  const repos = listRepos().filter((r) => r.entry.enabled);

  // Fast path 1: exact local_path match (no filesystem/git work).
  for (const r of repos) {
    if (r.entry.local_path === cwd) {
      const hit: ResolvedRepo = { ...r, resolved_url: r.canonical_url };
      cwdRepoCache.set(cwd, hit);
      return hit;
    }
  }

  // Fast path 2: cwd is inside an enabled repo — its git toplevel equals a
  // registered local_path. Pure filesystem walk, no shell.
  const top = findGitRoot(cwd);
  if (top) {
    for (const r of repos) {
      if (r.entry.local_path === top) {
        const hit: ResolvedRepo = { ...r, resolved_url: r.canonical_url };
        cwdRepoCache.set(cwd, hit);
        return hit;
      }
    }
  }

  // Slow path: resolve the cwd's git remote and match on canonical URL. Catches
  // a same-remote clone/worktree living under an unregistered path.
  const identity = detectRepo(cwd);
  if (identity) {
    for (const r of repos) {
      if (r.canonical_url === identity.canonical_url) {
        const hit: ResolvedRepo = { ...r, resolved_url: identity.canonical_url };
        cwdRepoCache.set(cwd, hit);
        return hit;
      }
    }
  }

  cwdRepoCache.set(cwd, null);
  return null;
};

/** Test-only: clear the cwd→repo memo so config changes take effect. */
export const _clearCwdRepoCache = (): void => cwdRepoCache.clear();
