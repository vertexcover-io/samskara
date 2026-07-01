// AI-generated. See PROMPT.md for the prompts and model used.

import { existsSync, statSync } from "node:fs";
import { streamEvents } from "@claude-sessions/adapter-claude";
import { type CanonicalEvent, detectRepo, redact } from "@claude-sessions/core";
import { type ResolvedRepo, resolveEnabledRepoForCwd } from "../config/repos.js";
import { getFileState, setFileState } from "../config/state.js";
import { readSessionMeta } from "../discover.js";
import { listCommitsInWindow } from "../git-commits.js";
import type { IngestEvent, IngestPayload, UploadClient } from "../upload/client.js";
import { isSessionMarkedPrivate } from "./privacy.js";

/**
 * Walk an arbitrary value, redacting every string leaf in place. Wraps the
 * core single-string `redact()` so we strip secrets from `payload` blobs
 * before they leave the device (REQ-005).
 */
const redactDeep = (value: unknown): unknown => {
  if (typeof value === "string") return redact(value).redacted;
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v);
    }
    return out;
  }
  return value;
};

/**
 * Canonical projection: the fields the web UI / search reads off `payload`.
 * We deliberately strip `raw` here — the original line is preserved in the
 * session blob upload, so there's no value in shipping it twice.
 */
const canonicalPayload = (ev: CanonicalEvent): Record<string, unknown> => {
  switch (ev.type) {
    case "user_msg":
      return { content_md: ev.content_md };
    case "assistant_msg":
      return {
        content_md: ev.content_md,
        ...(ev.model !== undefined ? { model: ev.model } : {}),
        ...(ev.usage !== undefined ? { usage: ev.usage } : {}),
      };
    case "tool_use":
      return {
        tool: ev.tool,
        tool_use_id: ev.tool_use_id,
        input_summary: ev.input_summary,
        ...(ev.output_summary !== undefined ? { output_summary: ev.output_summary } : {}),
        ...(ev.is_error !== undefined ? { is_error: ev.is_error } : {}),
        ...(ev.agent_id !== undefined ? { agent_id: ev.agent_id } : {}),
      };
    case "summary":
      return { content: ev.content };
    case "system":
      return {
        kind: ev.kind,
        content: ev.content,
        ...(ev.data !== undefined ? { data: ev.data } : {}),
      };
  }
};

const toIngestEvent = (ev: CanonicalEvent): IngestEvent => ({
  event_uuid: ev.event_uuid,
  parent_uuid: ev.parent_uuid,
  ts: ev.ts,
  type: ev.type,
  payload: redactDeep(canonicalPayload(ev)),
});

export interface ConsumeOptions {
  /** When false, only attempt to read past the persisted offset. */
  fullScan?: boolean;
  /** Override the repo lookup (tests can hand in a stub). */
  isPathEnabled?: (cwd: string) => boolean;
}

/**
 * Thrown when the server returns 2xx for an ingest batch but accounts for
 * fewer events than we sent (accepted + duplicates < sent). Signals that the
 * offset must NOT advance — the events did not durably land. Non-fatal: the
 * watcher's next tick re-reads from the un-advanced offset and retries.
 */
export class IngestVerificationError extends Error {
  constructor(
    readonly sessionId: string,
    readonly sent: number,
    readonly confirmed: number,
  ) {
    super(
      `ingest verification failed for ${sessionId}: sent ${sent} events, server confirmed ${confirmed}`,
    );
    this.name = "IngestVerificationError";
  }
}

export interface ConsumeResult {
  uploaded: number;
  skipped: boolean;
  reason?: string;
}

/** Treat 1970-01-01 (epoch) as a sentinel for "no real timestamp". The
 *  adapter falls back to epoch on records that lack a `timestamp` field
 *  (e.g. the `last-prompt` / `permission-mode` meta records that newer
 *  Claude Code transcripts prepend), so we can't trust the first/last
 *  event blindly when computing session bounds. */
const isRealTs = (s: string | undefined): s is string => {
  if (!s) return false;
  const ms = Date.parse(s);
  return Number.isFinite(ms) && ms > 0;
};

/**
 * Subagent transcripts live at
 * `…/<MAIN_SESSION_ID>/subagents/agent-<AGENT_ID>.jsonl`. Their internal
 * `sessionId` field collides with the parent's, so we key the child session
 * off the `<AGENT_ID>` in the path and stamp the parent link from `<MAIN>`.
 */
const SUBAGENT_RE = /\/([0-9a-f-]{36})\/subagents\/agent-([a-f0-9]+)\.jsonl$/;

const detectSubagent = (path: string): { mainSessionId: string; agentId: string } | null => {
  const m = path.match(SUBAGENT_RE);
  if (!m?.[1] || !m[2]) return null;
  return { mainSessionId: m[1], agentId: m[2] };
};

/**
 * The adapter stamps `agent_id` on the tool_result event (that's where the
 * "agentId: …" launch text lives), but the web reads it off the Agent *call*
 * event. The streaming upload path here does NOT run readSessionSync's
 * call↔result pairing, so propagate agent_id from each result onto its call
 * (matched by `tool_use_id`) before upload. Without this the call event ships
 * without agent_id and the web never shows the drill-in affordance.
 */
const linkAgentIds = (events: CanonicalEvent[]): void => {
  const agentIdByToolUse = new Map<string, string>();
  for (const ev of events) {
    if (ev.type === "tool_use" && ev.agent_id && ev.tool_use_id) {
      agentIdByToolUse.set(ev.tool_use_id, ev.agent_id);
    }
  }
  if (agentIdByToolUse.size === 0) return;
  for (const ev of events) {
    if (ev.type === "tool_use" && ev.tool && !ev.agent_id) {
      const aid = agentIdByToolUse.get(ev.tool_use_id);
      if (aid) ev.agent_id = aid;
    }
  }
};

const buildSessionPayload = (
  sessionId: string,
  cwd: string,
  events: CanonicalEvent[],
  canonicalUrl: string,
  parentSessionId?: string,
): IngestPayload => {
  const fallback = new Date().toISOString();
  const ts0 = events.find((e) => isRealTs(e.ts))?.ts ?? fallback;
  let tsN = ts0;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev && isRealTs(ev.ts)) {
      tsN = ev.ts;
      break;
    }
  }
  let model: string | null = null;
  let inTokens = 0;
  let outTokens = 0;
  let branch: string | null = null;
  for (const ev of events) {
    // gitBranch lives on raw — not lifted onto canonical, so peek there.
    const raw = ev.raw as Record<string, unknown> | null | undefined;
    if (raw && typeof raw.gitBranch === "string" && raw.gitBranch.length > 0) {
      branch = raw.gitBranch;
    }
    if (ev.type === "assistant_msg") {
      if (ev.model) model = ev.model;
      if (ev.usage) {
        inTokens += ev.usage.input_tokens ?? 0;
        outTokens += ev.usage.output_tokens ?? 0;
      }
    }
  }
  return {
    session: {
      id: sessionId,
      agent: "claude-code",
      agent_version: "1.0.0",
      repo: { canonical_url: canonicalUrl, branch },
      ...(parentSessionId !== undefined ? { parent_session_id: parentSessionId } : {}),
      source_cwd_hint: cwd,
      started_at: ts0,
      ended_at: tsN,
      model,
      permission_mode: null,
      total_input_tokens: inTokens,
      total_output_tokens: outTokens,
      total_cost_usd: 0,
    },
    events: events.map(toIngestEvent),
  };
};

/**
 * Resolve the repo a session cwd belongs to, by git identity (see
 * `resolveEnabledRepoForCwd`) rather than exact path equality — a session's
 * cwd is often a subdirectory, worktree, or renamed clone of the enabled repo.
 *
 * When `forceEnabled` is set (the `isPathEnabled` override / `sync --verify`
 * repair path), a cwd that maps to no *enabled* repo still resolves via
 * `detectRepo` so the events can be ingested with a correct canonical URL.
 */
const repoForCwd = (cwd: string, forceEnabled: boolean): ResolvedRepo | null => {
  const enabled = resolveEnabledRepoForCwd(cwd);
  if (enabled) return enabled;
  if (!forceEnabled) return null;
  // Forced ingest (explicit repair): derive identity straight from git so we
  // still ship a real canonical_url + local_path for a repo that isn't enabled.
  const identity = detectRepo(cwd);
  if (!identity) return null;
  return {
    canonical_url: identity.canonical_url,
    entry: {
      local_path: identity.toplevel,
      enabled: false,
      manual_override_url: null,
      enabled_at: "",
    },
    resolved_url: identity.canonical_url,
  };
};

/**
 * Consume new bytes from a single JSONL file → POST → advance offset.
 *
 * Strict ordering: the persisted byte offset advances ONLY after the upload
 * resolves successfully (REQ-045). On failure, the offset stays put, the
 * watcher's next tick re-reads, and the server dedupes on `event_uuid`.
 *
 * Inode replacement (EDGE-002): the previous offset may now point past the
 * new file's end. We detect that via `stat` and reset the offset to 0 so
 * we re-emit the new file's contents. Server still dedupes by event_uuid
 * if the file is a copy.
 */
export const consumeFile = async (
  path: string,
  client: UploadClient,
  opts: ConsumeOptions = {},
): Promise<ConsumeResult> => {
  if (!existsSync(path)) return { uploaded: 0, skipped: true, reason: "missing" };
  void opts;

  const cur = getFileState(path);
  let offset = opts.fullScan ? 0 : (cur?.byte_offset ?? 0);
  const size = statSync(path).size;
  // EDGE-002: file shrunk (rotation/inode replacement) — reset offset.
  if (size < offset) offset = 0;
  if (size === offset) return { uploaded: 0, skipped: true, reason: "no-new-bytes" };

  const meta = readSessionMeta(path);
  if (!meta.cwd) return { uploaded: 0, skipped: true, reason: "no-cwd" };

  // `isPathEnabled` lets callers force ingest past the enable gate (tests, and
  // `sync --verify`'s explicit repair). Default gating is git-identity based.
  const forced = opts.isPathEnabled ? opts.isPathEnabled(meta.cwd) : false;
  const repo = repoForCwd(meta.cwd, forced);
  if (!repo) return { uploaded: 0, skipped: true, reason: "not-enabled" };

  // REQ-040 + EDGE-018/EDGE-019: a sidecar marker withdraws the session
  // and stops further uploads. We advance the byte offset to "current EOF"
  // so we don't re-stream these events on the next tick — the sidecar is
  // the single source of truth, not the event log.
  if (meta.session_id && isSessionMarkedPrivate(meta.session_id)) {
    try {
      await client.patchSession(meta.session_id, { is_private: true });
    } catch {
      // If the cloud copy was never uploaded, PATCH returns 404 — that's
      // fine: nothing to withdraw. Other errors we deliberately swallow
      // here too; the sidecar still blocks the upload, and the next tick
      // will retry. Surfacing the error would block the watcher.
    }
    await setFileState(path, {
      byte_offset: size,
      last_event_uuid: cur?.last_event_uuid ?? null,
      session_id: meta.session_id,
      last_seen_at: new Date().toISOString(),
    });
    return { uploaded: 0, skipped: true, reason: "private" };
  }

  const collected: CanonicalEvent[] = [];
  // Dedupe defensively on event_uuid: server upserts on the composite
  // (session_id, event_uuid) PK, and Postgres errors on duplicate rows
  // within a single ON CONFLICT statement. Last-write-wins.
  const seen = new Map<string, number>();
  for await (const ev of streamEvents(path, { byteOffset: offset })) {
    const idx = seen.get(ev.event_uuid);
    if (idx !== undefined) {
      collected[idx] = ev;
    } else {
      seen.set(ev.event_uuid, collected.length);
      collected.push(ev);
    }
  }
  if (collected.length === 0) {
    await setFileState(path, {
      byte_offset: size,
      last_event_uuid: cur?.last_event_uuid ?? null,
      session_id: meta.session_id ?? cur?.session_id ?? null,
      last_seen_at: new Date().toISOString(),
    });
    return { uploaded: 0, skipped: true, reason: "no-events" };
  }

  // Propagate agent_id from Agent tool_result events onto their call events
  // so the uploaded call (tool="Agent") carries the link the web reads.
  linkAgentIds(collected);

  // Subagent transcripts collide on `sessionId` with their parent; key the
  // child off the path's `<AGENT_ID>` and stamp the parent link.
  const subagent = detectSubagent(path);
  const sessionId = subagent?.agentId ?? meta.session_id ?? collected[0]?.event_uuid ?? path;
  const fullPayload = buildSessionPayload(
    sessionId,
    meta.cwd,
    collected,
    repo.resolved_url,
    subagent?.mainSessionId,
  );

  // Mine commits authored in the session window from the local repo. Best
  // effort — if `git` is missing or the path isn't a repo, list returns
  // empty and we just don't ship any commits.
  let commits: NonNullable<IngestPayload["commits"]> | undefined;
  try {
    const c = listCommitsInWindow(
      repo.entry.local_path,
      fullPayload.session.started_at,
      fullPayload.session.ended_at,
    );
    if (c.length > 0) commits = c;
  } catch {
    // ignore — commits are non-essential for ingest
  }

  // Server caps each ingest batch at 500 events. Split large batches; the
  // server dedupes on event_uuid so retrying the whole window on a partial
  // failure is safe (offset advances only after every chunk succeeds).
  const CHUNK = 500;
  let confirmed = 0;
  for (let i = 0; i < fullPayload.events.length; i += CHUNK) {
    const slice = fullPayload.events.slice(i, i + CHUNK);
    const chunkPayload: IngestPayload = {
      session: fullPayload.session,
      events: slice,
      ...(i === 0 && commits ? { commits } : {}),
    };
    const res = await client.ingest(chunkPayload);
    confirmed += res.accepted_events + res.skipped_duplicates;
  }

  // The server MUST account for every event we sent — either freshly accepted
  // or recognized as a duplicate. A 2xx that persisted fewer rows than we sent
  // (transient DB blip, a deploy mid-request, a partial commit) would otherwise
  // let us advance the offset over events that never landed, stranding them
  // forever with no error. Throwing here keeps the offset put; the next tick
  // re-reads and the server dedupes on event_uuid, so the retry is idempotent.
  if (confirmed !== fullPayload.events.length) {
    throw new IngestVerificationError(sessionId, fullPayload.events.length, confirmed);
  }

  const lastUuid = collected[collected.length - 1]?.event_uuid ?? null;
  await setFileState(path, {
    byte_offset: size,
    last_event_uuid: lastUuid,
    session_id: sessionId,
    last_seen_at: new Date().toISOString(),
  });

  return { uploaded: collected.length, skipped: false };
};

// Lookup helper exposed for tests.
export const _internal = { redactDeep, repoForCwd, buildSessionPayload };
