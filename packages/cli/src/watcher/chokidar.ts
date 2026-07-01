// AI-generated. See PROMPT.md for the prompts and model used.

import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { type FSWatcher, watch as chokidarWatch } from "chokidar";
import { listRepos } from "../config/repos.js";
import { findSessionsForRepo } from "../discover.js";
import { HttpError, type UploadClient } from "../upload/client.js";
import { consumeFile } from "./consume.js";

/**
 * Long-running JSONL tail. Watches the parent directories of every JSONL
 * we already know about for an enabled repo, plus picks up new JSONL
 * files as Claude rotates / starts new sessions.
 *
 * `start()` does an initial catch-up pass before installing the chokidar
 * listener so REQ-013 (backfill on watcher start) is satisfied.
 *
 * The watcher only tails and uploads — it never summarizes. Summaries are
 * authored by the in-loop agent (`summarize --from-agent`); there is no
 * timer-based end-of-session trigger.
 */

export interface JsonlWatcherOptions {
  client: UploadClient;
  /** Override the file discovery (tests inject a fixed list). */
  discover?: () => string[];
  /** Override the chokidar watcher (tests inject a stub). */
  chokidarFactory?: typeof chokidarWatch;
  /** Where to log warnings (default: console.error). */
  logger?: (msg: string) => void;
}

/**
 * Subagent transcripts for a main session `<project>/<MAIN>.jsonl` live in
 * `<project>/<MAIN>/subagents/**\/agent-*.jsonl`. Glob them so the catch-up
 * pass backfills child sessions. The dir may not exist (no subagents ran).
 */
const subagentFilesFor = (mainFile: string): string[] => {
  const dir = mainFile.replace(/\.jsonl$/, "");
  const root = join(dir, "subagents");
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (d: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(d, name);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
      else if (st.isFile() && name.startsWith("agent-") && name.endsWith(".jsonl")) out.push(full);
    }
  };
  walk(root);
  return out;
};

const defaultDiscover = (): string[] => {
  const out = new Set<string>();
  for (const r of listRepos()) {
    if (!r.entry.enabled) continue;
    for (const f of findSessionsForRepo(r.canonical_url, [r.entry.local_path])) {
      out.add(f.path);
      for (const sub of subagentFilesFor(f.path)) out.add(sub);
    }
  }
  return Array.from(out);
};

/**
 * Only LIVE-watch the `subagents/` dir of a *recently active* main session.
 * Old sessions never spawn new subagents, and registering an inotify watch
 * for every historical subagents dir exhausts the system watch limit
 * (ENOSPC), which would crash the watcher. The startup catch-up pass already
 * backfilled every historical subagent transcript, and `ensureSubagentWatch`
 * registers dirs on the fly as sessions become active.
 */
const LIVE_WATCH_MAX_AGE_MS = 48 * 60 * 60 * 1000;

const modifiedWithin = (path: string, maxAgeMs: number): boolean => {
  try {
    return Date.now() - statSync(path).mtimeMs < maxAgeMs;
  } catch {
    return false;
  }
};

export class JsonlWatcher {
  private opts: JsonlWatcherOptions;
  private watcher: FSWatcher | null = null;
  private inflight = new Map<string, Promise<void>>();
  private watchedSubagentDirs = new Set<string>();

  constructor(opts: JsonlWatcherOptions) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    const files = (this.opts.discover ?? defaultDiscover)();
    // Catch-up pass first — backfill pre-existing JSONLs (REQ-013). This
    // includes historical subagent transcripts, so we do NOT need a live
    // watch on every historical subagents dir (that would exhaust inotify).
    for (const f of files) await this.consumeSafe(f);
    // Live watch: the parent dir of every main JSONL, plus the subagents dir
    // of recently-active sessions only. Newly-active sessions register their
    // subagents dir on the fly via `ensureSubagentWatch`.
    const dirSet = new Set<string>();
    for (const f of files) {
      if (basename(dirname(f)) === "subagents") continue;
      dirSet.add(dirname(f));
      if (modifiedWithin(f, LIVE_WATCH_MAX_AGE_MS)) {
        const subDir = join(f.replace(/\.jsonl$/, ""), "subagents");
        if (existsSync(subDir)) {
          dirSet.add(subDir);
          this.watchedSubagentDirs.add(subDir);
        }
      }
    }
    const dirs = Array.from(dirSet);
    if (dirs.length === 0) return;
    const factory = this.opts.chokidarFactory ?? chokidarWatch;
    this.watcher = factory(dirs, {
      persistent: true,
      ignoreInitial: true,
      depth: 1,
    });
    // Never let a watcher-level error (e.g. ENOSPC from the inotify limit)
    // crash the process — log it and keep tailing whatever did register.
    this.watcher.on("error", (err: unknown) => {
      const log = this.opts.logger ?? ((m) => console.error(m));
      log(`watch error (continuing): ${(err as Error)?.message ?? err}`);
    });
    const onChange = (p: string): void => {
      if (!p.endsWith(".jsonl")) return;
      // An active main session may spawn subagents — start watching its
      // subagents dir so their transcripts are captured live.
      this.ensureSubagentWatch(p);
      void this.consumeSafe(p);
    };
    this.watcher.on("change", onChange);
    this.watcher.on("add", onChange);
  }

  /** Lazily register a live watch on a main session's `subagents/` dir the
   *  first time we see that session active, so subagents spawned after the
   *  watcher started are captured — without pre-watching every historical
   *  dir at startup (which would hit the inotify limit). */
  private ensureSubagentWatch(mainFile: string): void {
    if (!this.watcher) return;
    if (basename(dirname(mainFile)) === "subagents") return;
    const subDir = join(mainFile.replace(/\.jsonl$/, ""), "subagents");
    if (this.watchedSubagentDirs.has(subDir)) return;
    if (!existsSync(subDir)) return;
    this.watchedSubagentDirs.add(subDir);
    const log = this.opts.logger ?? ((m) => console.error(m));
    try {
      this.watcher.add(subDir);
    } catch (err) {
      log(`subagent watch skipped for ${subDir}: ${(err as Error)?.message ?? err}`);
      return;
    }
    // Backfill any subagent transcripts already present — chokidar won't
    // re-emit pre-existing files when a dir is added after startup.
    for (const sub of subagentFilesFor(mainFile)) void this.consumeSafe(sub);
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    await Promise.allSettled(this.inflight.values());
  }

  /** Wait for any in-flight consume to settle (test helper). */
  async drain(): Promise<void> {
    await Promise.allSettled(this.inflight.values());
  }

  private async consumeSafe(path: string): Promise<void> {
    // Serialize per-file so a quick burst of writes doesn't trigger
    // overlapping consumes that would race on `state.json`.
    const prev = this.inflight.get(path) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(async () => {
        const log = this.opts.logger ?? ((m) => console.error(m));
        try {
          const result = await consumeFile(path, this.opts.client);
          // Log the happy path too: a silent success is indistinguishable from
          // "never ran" in watch.log, which is exactly how event-loss went
          // unnoticed. One line per real upload makes a gap visible evidence.
          if (!result.skipped && result.uploaded > 0) {
            log(`uploaded ${result.uploaded} event(s) for ${basename(path)}`);
          }
        } catch (err) {
          if (err instanceof HttpError) {
            log(`upload failed for ${path}: ${err.message}`);
          } else {
            log(`consume failed for ${path}: ${(err as Error).message ?? err}`);
          }
        }
      });
    this.inflight.set(
      path,
      next.finally(() => {
        if (this.inflight.get(path) === next) this.inflight.delete(path);
      }),
    );
    await next;
  }
}
