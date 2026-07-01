// AI-generated. See PROMPT.md for the prompts and model used.

import { streamEvents } from "@claude-sessions/adapter-claude";
import { listRepos } from "../config/repos.js";
import { findSessionsForRepo, readSessionMeta } from "../discover.js";
import type { UploadClient } from "../upload/client.js";
import { consumeFile } from "../watcher/consume.js";

export interface SyncOptions {
  client: UploadClient;
  fullScan?: boolean;
  /**
   * Reconciliation mode: compare each local session's event count against the
   * server and re-push any session the server is missing events for. Unlike a
   * normal sync this covers sessions in currently-disabled repos too, because
   * verifying integrity is an explicit user action, not passive capture.
   */
  verify?: boolean;
}

/** Count canonical events the adapter produces from a JSONL (dedup on uuid,
 *  mirroring the watcher so the comparison is apples-to-apples). */
const countLocalEvents = async (path: string): Promise<number> => {
  const seen = new Set<string>();
  for await (const ev of streamEvents(path, { byteOffset: 0 })) seen.add(ev.event_uuid);
  return seen.size;
};

const runVerify = async (opts: SyncOptions): Promise<number> => {
  let repushed = 0;
  let checked = 0;
  // Reconcile ALL local sessions, including disabled repos — an explicit
  // integrity pass shouldn't be gated by the passive-capture flag.
  for (const r of listRepos()) {
    const files = findSessionsForRepo(r.canonical_url, [r.entry.local_path]);
    for (const f of files) {
      const sessionId = f.session_id ?? readSessionMeta(f.path).session_id;
      if (!sessionId) continue;
      checked++;
      try {
        const [serverCount, localCount] = await Promise.all([
          opts.client.getEventCount(sessionId),
          countLocalEvents(f.path),
        ]);
        if (serverCount >= localCount || localCount === 0) continue;
        // Server is missing events for a session we have locally. Re-push the
        // whole file, bypassing the enable gate (this is an explicit repair).
        // full-scan re-reads from byte 0 so an offset already at EOF can't
        // short-circuit the push; the server dedupes on event_uuid.
        const result = await consumeFile(f.path, opts.client, {
          fullScan: true,
          isPathEnabled: () => true,
        });
        if (!result.skipped && result.uploaded > 0) {
          repushed++;
          process.stdout.write(
            `verify: re-pushed ${result.uploaded} event(s) for ${sessionId} (server had ${serverCount}, local ${localCount})\n`,
          );
        }
      } catch (err) {
        process.stderr.write(`verify failed for ${f.path}: ${(err as Error).message}\n`);
      }
    }
  }
  process.stdout.write(`verified ${checked} session(s); re-pushed ${repushed}\n`);
  return 0;
};

/**
 * `claude-sessions sync` — one-shot catch-up. Iterates every JSONL we know
 * about for any enabled repo and runs the consume pipeline once. Useful
 * after a fresh install or a long offline window before starting `watch`.
 *
 * With `--verify`, runs a reconciliation pass instead: re-push any session the
 * server is missing events for (heals title-without-logs sessions).
 */
export const syncCommand = async (opts: SyncOptions): Promise<number> => {
  if (opts.verify) return runVerify(opts);

  let total = 0;
  for (const r of listRepos()) {
    if (!r.entry.enabled) continue;
    const files = findSessionsForRepo(r.canonical_url, [r.entry.local_path]);
    for (const f of files) {
      try {
        const result = await consumeFile(f.path, opts.client, { fullScan: opts.fullScan });
        total += result.uploaded;
      } catch (err) {
        process.stderr.write(`sync failed for ${f.path}: ${(err as Error).message}\n`);
      }
    }
  }
  process.stdout.write(`synced ${total} event(s)\n`);
  return 0;
};
