// AI-generated. See PROMPT.md for the prompts and model used.

import { retryWithBackoff } from "./retry.js";

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(`HTTP ${status}: ${message}`);
    this.status = status;
  }
}

export interface IngestSessionMeta {
  id: string;
  agent: "claude-code";
  agent_version: string;
  repo: { canonical_url: string; branch: string | null };
  /** Set when this is a captured subagent transcript; == the parent's id. */
  parent_session_id?: string;
  source_cwd_hint: string;
  started_at: string;
  ended_at: string;
  model: string | null;
  permission_mode: string | null;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
}

export interface IngestEvent {
  event_uuid: string;
  parent_uuid: string | null;
  ts: string;
  type: "user_msg" | "assistant_msg" | "tool_use" | "summary" | "system";
  payload: unknown;
}

export interface IngestCommit {
  sha: string;
  short_sha: string;
  author_name: string;
  author_email: string;
  authored_at: string;
  subject: string;
  branch: string | null;
  files_changed: number | null;
  insertions: number | null;
  deletions: number | null;
}

export interface IngestPayload {
  session: IngestSessionMeta;
  events: IngestEvent[];
  /** Commits authored on the local repo during the session window.
   *  Optional — sent only on the first batch of a session. */
  commits?: IngestCommit[];
}

export interface SessionDetailSummary {
  title: string | null;
  summary: string | null;
  tags: string[];
  files_touched: string[];
  prs_referenced: string[];
  tool_call_counts: Record<string, number>;
  status: "pending" | "ok" | "failed";
  summarized_event_count?: number | null;
  model?: string | null;
}

export interface LearningRecord {
  id: string;
  title: string;
  episode_event_uuids: string[];
  what_went_wrong: string;
  what_would_have_prevented: string;
  root_cause: string;
  attributed_to: string;
  confidence: number;
  severity: "low" | "medium" | "high" | null;
  model: string | null;
  generated_at: string | null;
  summarized_event_count: number | null;
}

export interface SessionDetail {
  id: string;
  summary: SessionDetailSummary | null;
  learnings?: LearningRecord[];
  [k: string]: unknown;
}

export interface SummarizationRunRow {
  id: string;
  session_id: string;
  attempt: number;
  status: "ok" | "failed";
  started_at: string;
  ended_at: string;
  duration_ms: number;
  duration_api_ms: number | null;
  claude_model: string;
  stop_reason: string | null;
  num_turns: number | null;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  total_cost_usd: string;
  prompt_chars: number;
  truncated: boolean;
  error: string | null;
}

export interface SummarizationStats {
  since: string | null;
  calls: number;
  successes: number;
  failures: number;
  retries: number;
  input_tokens: string | number;
  output_tokens: string | number;
  cache_creation_tokens: string | number;
  cache_read_tokens: string | number;
  total_cost_usd: string;
  avg_duration_ms: number | null;
  p95_duration_ms: number | null;
}

export interface SummarizationRunPayload {
  attempt: number;
  status: "ok" | "failed";
  started_at: string;
  ended_at: string;
  duration_ms: number;
  duration_api_ms: number | null;
  claude_model: string;
  stop_reason: string | null;
  num_turns: number | null;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  total_cost_usd: number;
  prompt_chars: number;
  truncated: boolean;
  error: string | null;
  raw_usage: unknown;
}

export interface UploadClientOptions {
  serverUrl: string;
  token: string;
  /** Inject undici MockAgent's `fetch` from tests; defaults to global. */
  fetchImpl?: typeof fetch;
  /** Override retry delays; tests pass `[]` to fail fast. */
  retryDelaysMs?: readonly number[];
}

/**
 * Thin wrapper around `fetch` that adds bearer auth, retry-with-backoff,
 * and translates 4xx/5xx into typed errors. The watcher's debouncer calls
 * `ingest()` for each batch; on success the watcher advances its persisted
 * byte offset (REQ-045).
 */
export class UploadClient {
  private serverUrl: string;
  private token: string;
  private fetchImpl: typeof fetch;
  private retryDelaysMs: readonly number[] | undefined;

  constructor(opts: UploadClientOptions) {
    this.serverUrl = opts.serverUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.retryDelaysMs = opts.retryDelaysMs;
  }

  private async request(path: string, body: unknown, method = "POST"): Promise<unknown> {
    const res = await this.fetchImpl(`${this.serverUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      // 4xx is fatal — auth or RBAC won't fix itself with a retry.
      // 5xx is retryable (network/server hiccup).
      throw new HttpError(res.status, text || res.statusText);
    }
    return text ? JSON.parse(text) : {};
  }

  /**
   * POST /api/sessions/:id/summary — body is the canonical SessionSummary
   * shape. Server generates the embedding inline (REQ-038), so this call
   * does not return until both rows are committed.
   */
  async uploadSummary(sessionId: string, summary: unknown): Promise<void> {
    await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/summary`, summary);
  }

  async recordSummarizationRun(sessionId: string, run: SummarizationRunPayload): Promise<void> {
    await this.request(`/api/sessions/${encodeURIComponent(sessionId)}/summarization-runs`, run);
  }

  async listSummarizationRuns(params: {
    since?: string;
    status?: "ok" | "failed";
    sessionId?: string;
    limit?: number;
  }): Promise<{ runs: SummarizationRunRow[] }> {
    const search = new URLSearchParams();
    if (params.since) search.set("since", params.since);
    if (params.status) search.set("status", params.status);
    if (params.sessionId) search.set("session_id", params.sessionId);
    if (params.limit !== undefined) search.set("limit", String(params.limit));
    const qs = search.toString();
    const res = await this.fetchImpl(
      `${this.serverUrl}/api/summarization-runs${qs ? `?${qs}` : ""}`,
      { method: "GET", headers: { authorization: `Bearer ${this.token}` } },
    );
    const text = await res.text();
    if (!res.ok) throw new HttpError(res.status, text || res.statusText);
    return text ? (JSON.parse(text) as { runs: SummarizationRunRow[] }) : { runs: [] };
  }

  async getSummarizationStats(params: {
    since?: string;
    sinceDays?: number;
  }): Promise<SummarizationStats> {
    const search = new URLSearchParams();
    if (params.since) search.set("since", params.since);
    if (params.sinceDays !== undefined) search.set("since_days", String(params.sinceDays));
    const qs = search.toString();
    const res = await this.fetchImpl(
      `${this.serverUrl}/api/summarization-runs/stats${qs ? `?${qs}` : ""}`,
      { method: "GET", headers: { authorization: `Bearer ${this.token}` } },
    );
    const text = await res.text();
    if (!res.ok) throw new HttpError(res.status, text || res.statusText);
    return JSON.parse(text) as SummarizationStats;
  }

  /**
   * PUT /api/sessions/:id/blob — raw NDJSON bytes. Used after the
   * summary upload so a search hit can deep-link to the full transcript
   * (REQ-061).
   */
  async uploadBlob(sessionId: string, bytes: Uint8Array | Buffer): Promise<void> {
    const body =
      bytes instanceof Buffer
        ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        : bytes;
    const res = await this.fetchImpl(
      `${this.serverUrl}/api/sessions/${encodeURIComponent(sessionId)}/blob`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/x-ndjson",
          authorization: `Bearer ${this.token}`,
        },
        body,
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new HttpError(res.status, text || res.statusText);
    }
  }

  async ingest(
    payload: IngestPayload,
  ): Promise<{ accepted_events: number; skipped_duplicates: number }> {
    // 4xx is non-retryable: auth/RBAC errors won't heal on their own. Server
    // returns 5xx for transient failures — those flow through retryWithBackoff.
    return (await retryWithBackoff(
      async () =>
        (await this.request("/api/ingest", payload)) as {
          accepted_events: number;
          skipped_duplicates: number;
        },
      {
        ...(this.retryDelaysMs !== undefined ? { delaysMs: this.retryDelaysMs } : {}),
        shouldRetry: (err) => !(err instanceof HttpError && err.status >= 400 && err.status < 500),
      },
    )) as { accepted_events: number; skipped_duplicates: number };
  }

  /**
   * POST /api/sessions/:id/artifacts — push a single file an agent
   * created/edited during the session. Body is already redacted by the
   * caller (load-bearing CLI invariant). Returns 413 for >5MB content,
   * 404 if the session isn't owned. 4xx is non-retryable, mirroring
   * `ingest()`.
   */
  async uploadArtifact(
    sessionId: string,
    artifact: { path: string; mime_type: string; content: string },
  ): Promise<{ id: string; byte_size: number }> {
    return (await retryWithBackoff(
      async () =>
        (await this.request(
          `/api/sessions/${encodeURIComponent(sessionId)}/artifacts`,
          artifact,
        )) as { id: string; byte_size: number },
      {
        ...(this.retryDelaysMs !== undefined ? { delaysMs: this.retryDelaysMs } : {}),
        shouldRetry: (err) => !(err instanceof HttpError && err.status >= 400 && err.status < 500),
      },
    )) as { id: string; byte_size: number };
  }

  async enableRepo(canonicalUrl: string, localPath: string): Promise<void> {
    await this.request("/api/repos/enable", {
      canonical_url: canonicalUrl,
      local_path: localPath,
    });
  }

  async disableRepo(canonicalUrl: string, purge: boolean): Promise<void> {
    await this.request("/api/repos/disable", {
      canonical_url: canonicalUrl,
      purge,
    });
  }

  /**
   * GET /api/sessions/:id — full session metadata (used by `fork` to
   * resolve the source repo and by `name`/UI to render display_name).
   */
  async getSession(sessionId: string): Promise<SessionDetail> {
    const res = await this.fetchImpl(
      `${this.serverUrl}/api/sessions/${encodeURIComponent(sessionId)}`,
      {
        method: "GET",
        headers: { authorization: `Bearer ${this.token}` },
      },
    );
    const text = await res.text();
    if (!res.ok) throw new HttpError(res.status, text || res.statusText);
    return text
      ? (JSON.parse(text) as SessionDetail)
      : ({ id: sessionId, summary: null } as SessionDetail);
  }

  /**
   * Server-side count of stored events for a session. Used by `sync --verify`
   * to detect sessions whose events never landed (title/summary present,
   * transcript empty). Returns 0 for an unknown session so a missing row
   * reconciles as "needs push".
   *
   * Prefers the lightweight `GET /:id/event-count`. Against an OLDER server
   * that lacks that route, a 404 is ambiguous (endpoint-missing vs
   * session-missing), so we fall back to counting `GET /:id/events` rather than
   * assuming 0 — otherwise every session would be re-pushed on every run.
   */
  async getEventCount(sessionId: string): Promise<number> {
    const id = encodeURIComponent(sessionId);
    const res = await this.fetchImpl(`${this.serverUrl}/api/sessions/${id}/event-count`, {
      method: "GET",
      headers: { authorization: `Bearer ${this.token}` },
    });
    if (res.status === 404) {
      // Distinguish "no such route" (older server) from "no such session".
      const evRes = await this.fetchImpl(`${this.serverUrl}/api/sessions/${id}/events`, {
        method: "GET",
        headers: { authorization: `Bearer ${this.token}` },
      });
      if (evRes.status === 404) return 0;
      const evText = await evRes.text();
      if (!evRes.ok) throw new HttpError(evRes.status, evText || evRes.statusText);
      const evBody = evText ? (JSON.parse(evText) as { events?: unknown[] }) : {};
      return evBody.events?.length ?? 0;
    }
    const text = await res.text();
    if (!res.ok) throw new HttpError(res.status, text || res.statusText);
    const body = text ? (JSON.parse(text) as { count?: number }) : {};
    return body.count ?? 0;
  }

  /**
   * GET /api/sessions/:id/blob — raw NDJSON bytes used by `fork` to
   * reconstruct a resumable transcript locally.
   */
  async getBlobBytes(sessionId: string): Promise<Uint8Array> {
    const res = await this.fetchImpl(
      `${this.serverUrl}/api/sessions/${encodeURIComponent(sessionId)}/blob`,
      {
        method: "GET",
        headers: { authorization: `Bearer ${this.token}` },
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new HttpError(res.status, text || res.statusText);
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  /**
   * PATCH /api/sessions/:id — set/clear name or flip is_private.
   */
  async patchSession(
    sessionId: string,
    body: { name?: string | null; is_private?: boolean },
  ): Promise<void> {
    await this.request(`/api/sessions/${encodeURIComponent(sessionId)}`, body, "PATCH");
  }
}
