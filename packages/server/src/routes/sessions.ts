// AI-generated. See PROMPT.md for the prompts and model used.

import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { type AuthVariables, buildRequireAuth } from "../auth/middleware.js";
import type { DbClient } from "../db/client.js";
import {
  events,
  artifacts,
  embeddings,
  learnings,
  repos,
  sessionBlobs,
  sessionCommits,
  sessions,
  summaries,
  summarizationRuns,
  users,
} from "../db/schema.js";
import { getEmbedProvider } from "../embed/index.js";
import type { Env } from "../env.js";
import { writeAudit } from "../lib/audit.js";
import { redactDeep } from "../redact.js";

const learningSchema = z.object({
  title: z.string().min(1),
  episode_event_uuids: z.array(z.string()).min(1),
  what_went_wrong: z.string().min(1),
  what_would_have_prevented: z.string().min(1),
  root_cause: z.enum([
    "underspecified_request",
    "instruction_not_followed",
    "missing_verification",
    "task_derailment",
    "context_loss",
    "environment_or_tooling",
  ]),
  attributed_to: z.enum(["user", "agent", "shared", "environment"]),
  confidence: z.number().min(0).max(1),
  severity: z.enum(["low", "medium", "high"]).optional(),
});

const summarySchema = z.object({
  session_id: z.string().min(1),
  title: z.string(),
  summary: z.string(),
  tags: z.array(z.string()),
  files_touched: z.array(z.string()),
  prs_referenced: z.array(z.string()),
  tool_call_counts: z.record(z.number().int().nonnegative()),
  generated_at: z.string().datetime(),
  model: z.string(),
  status: z.enum(["pending", "ok", "failed"]),
  error: z.string().optional(),
  summarized_event_count: z.number().int().nonnegative().optional(),
  learnings: z.array(learningSchema).optional(),
});

const patchSchema = z.object({
  name: z.string().nullable().optional(),
  is_private: z.boolean().optional(),
});

const summarizationRunSchema = z.object({
  attempt: z.number().int().min(1),
  status: z.enum(["ok", "failed"]),
  started_at: z.string().datetime(),
  ended_at: z.string().datetime(),
  duration_ms: z.number().int().nonnegative(),
  duration_api_ms: z.number().int().nonnegative().nullable().optional(),
  claude_model: z.string().min(1),
  stop_reason: z.string().nullable().optional(),
  num_turns: z.number().int().nonnegative().nullable().optional(),
  input_tokens: z.number().int().nonnegative().default(0),
  output_tokens: z.number().int().nonnegative().default(0),
  cache_creation_tokens: z.number().int().nonnegative().default(0),
  cache_read_tokens: z.number().int().nonnegative().default(0),
  total_cost_usd: z.number().nonnegative().default(0),
  prompt_chars: z.number().int().nonnegative(),
  truncated: z.boolean().default(false),
  error: z.string().nullable().optional(),
  raw_usage: z.unknown().optional(),
});

const MAX_BLOB_BYTES = 100 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;

const artifactSchema = z.object({
  path: z.string().min(1),
  mime_type: z.string().min(1),
  content: z.string(),
});

const ensureString = (s: unknown): string => (typeof s === "string" ? s : "");

const recentQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  branch: z.string().optional(),
  agent: z.string().optional(),
});

export const buildSessionsRouter = (db: DbClient, env: Env): Hono<{ Variables: AuthVariables }> => {
  const router = new Hono<{ Variables: AuthVariables }>();
  router.use("*", buildRequireAuth(env));

  /**
   * GET /api/sessions — recent sessions across the whole org (global reads).
   * Used by the web Home / Recent feed. Private sessions are hidden from
   * everyone. Each row carries its author (github login + avatar). Optional
   * `?user=<github_login>` narrows to one author.
   */
  router.get("/", async (c) => {
    const url = new URL(c.req.url);
    const parsed = recentQuerySchema.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const params = parsed.data;
    // Repeated ?repo= / ?user= params accumulate into OR-sets (multi-select).
    const repoFilters = url.searchParams.getAll("repo");
    const userFilters = url.searchParams.getAll("user");

    const filters = [isNull(sessions.parentSessionId), eq(sessions.isPrivate, false)];
    if (params.agent) filters.push(eq(sessions.agent, params.agent));
    if (params.branch) filters.push(eq(sessions.branch, params.branch));
    if (userFilters.length > 0) {
      const lowered = userFilters.map((u) => u.toLowerCase());
      filters.push(inArray(sql`lower(${users.githubLogin})`, lowered));
    }
    if (repoFilters.length > 0) {
      const r = await db
        .select({ id: repos.id })
        .from(repos)
        .where(inArray(repos.canonicalUrl, repoFilters));
      if (r.length === 0) return c.json({ sessions: [] });
      filters.push(
        inArray(
          sessions.repoId,
          r.map((x) => x.id),
        ),
      );
    }

    const rows = await db
      .select({
        id: sessions.id,
        agent: sessions.agent,
        branch: sessions.branch,
        model: sessions.model,
        startedAt: sessions.startedAt,
        endedAt: sessions.endedAt,
        totalCostUsd: sessions.totalCostUsd,
        isPrivate: sessions.isPrivate,
        name: sessions.name,
        repoCanonicalUrl: repos.canonicalUrl,
        title: summaries.title,
        summary: summaries.summary,
        tags: summaries.tags,
        prsReferenced: summaries.prsReferenced,
        authorLogin: users.githubLogin,
        authorAvatar: users.avatarUrl,
      })
      .from(sessions)
      .leftJoin(repos, eq(repos.id, sessions.repoId))
      .leftJoin(summaries, eq(summaries.sessionId, sessions.id))
      .leftJoin(users, eq(users.id, sessions.userId))
      .where(and(...filters))
      .orderBy(desc(sessions.startedAt))
      .limit(params.limit);

    return c.json({
      sessions: rows.map((r) => ({
        id: r.id,
        agent: r.agent,
        branch: r.branch,
        model: r.model,
        started_at: r.startedAt.toISOString(),
        ended_at: r.endedAt.toISOString(),
        total_cost_usd: r.totalCostUsd,
        is_private: r.isPrivate,
        name: r.name,
        repo: r.repoCanonicalUrl,
        title: r.title ?? null,
        summary: r.summary ?? null,
        tags: r.tags ?? [],
        prs_referenced: r.prsReferenced ?? [],
        author: r.authorLogin ? { github_login: r.authorLogin, avatar_url: r.authorAvatar } : null,
        display_name: r.name ?? r.title ?? `Session ${r.id.slice(0, 8)}`,
      })),
    });
  });

  /**
   * GET /api/sessions/:id/events — return the canonical event stream for a
   * session in chronological order. Owner-only RBAC. Used by the transcript
   * view on the web UI.
   */
  router.get("/:id/events", async (c) => {
    const sessionId = c.req.param("id");

    const sessRows = await db
      .select({ id: sessions.id, isPrivate: sessions.isPrivate })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    const sess = sessRows[0];
    if (!sess) return c.json({ error: "session not found" }, 404);
    if (sess.isPrivate) return c.json({ events: [] });

    const rows = await db
      .select({
        eventUuid: events.eventUuid,
        parentUuid: events.parentUuid,
        ts: events.ts,
        type: events.type,
        payload: events.payload,
      })
      .from(events)
      .where(eq(events.sessionId, sessionId))
      .orderBy(asc(events.ts));

    return c.json({
      events: rows.map((r) => ({
        event_uuid: r.eventUuid,
        parent_uuid: r.parentUuid,
        ts: r.ts.toISOString(),
        type: r.type,
        payload: r.payload,
      })),
    });
  });

  /**
   * GET /api/sessions/:id/event-count — lightweight COUNT(*) of stored events.
   * Used by `sync --verify` to reconcile local vs server without pulling the
   * full events array. Owner-only RBAC; private sessions report 0 (masked).
   */
  router.get("/:id/event-count", async (c) => {
    const sessionId = c.req.param("id");

    const sessRows = await db
      .select({ id: sessions.id, isPrivate: sessions.isPrivate })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    const sess = sessRows[0];
    if (!sess) return c.json({ error: "session not found" }, 404);
    if (sess.isPrivate) return c.json({ count: 0 });

    const rows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(events)
      .where(eq(events.sessionId, sessionId));

    return c.json({ count: rows[0]?.count ?? 0 });
  });

  /**
   * GET /api/sessions/:id/tool-calls — paired tool calls + results, in
   * chronological order. The canonical event stream stores call and
   * result as two separate `tool_use` rows joined by `tool_use_id`; this
   * route does the join server-side so the web Tools tab can render
   * them as a single "called → completed" pair with both timestamps.
   */
  router.get("/:id/tool-calls", async (c) => {
    const sessionId = c.req.param("id");

    const sessRows = await db
      .select({ id: sessions.id, isPrivate: sessions.isPrivate })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    const sess = sessRows[0];
    if (!sess) return c.json({ error: "session not found" }, 404);
    if (sess.isPrivate) return c.json({ tool_calls: [] });

    const rows = await db
      .select({ ts: events.ts, payload: events.payload })
      .from(events)
      .where(and(eq(events.sessionId, sessionId), eq(events.type, "tool_use")))
      .orderBy(asc(events.ts));

    interface ToolPayload {
      tool?: string;
      tool_use_id?: string;
      input_summary?: string;
      output_summary?: string;
      is_error?: boolean;
    }
    interface Pair {
      tool_use_id: string;
      tool: string | null;
      input_summary: string | null;
      output_summary: string | null;
      is_error: boolean;
      called_at: string | null;
      completed_at: string | null;
      duration_ms: number | null;
    }
    const byId = new Map<string, Pair>();

    for (const r of rows) {
      const p = r.payload as ToolPayload;
      const id = p.tool_use_id;
      if (!id) continue;
      const ts = r.ts.toISOString();
      const existing = byId.get(id) ?? {
        tool_use_id: id,
        tool: null,
        input_summary: null,
        output_summary: null,
        is_error: false,
        called_at: null,
        completed_at: null,
        duration_ms: null,
      };
      // The "call" side is the assistant-emitted record: has a tool name
      // + input_summary. The "result" side is the user-shaped tool_result:
      // has output_summary, blank tool name.
      const isCall = !!p.tool && !!p.input_summary;
      if (isCall) {
        existing.tool = p.tool ?? existing.tool;
        existing.input_summary = p.input_summary ?? existing.input_summary;
        existing.called_at = ts;
        if (p.is_error === true) existing.is_error = true;
      } else {
        existing.output_summary = p.output_summary ?? existing.output_summary;
        existing.completed_at = ts;
        if (p.is_error === true) existing.is_error = true;
      }
      byId.set(id, existing);
    }

    const pairs = [...byId.values()];
    for (const p of pairs) {
      if (p.called_at && p.completed_at) {
        p.duration_ms = new Date(p.completed_at).getTime() - new Date(p.called_at).getTime();
      }
    }
    pairs.sort((a, b) => {
      const at = a.called_at ?? a.completed_at ?? "";
      const bt = b.called_at ?? b.completed_at ?? "";
      return at < bt ? -1 : at > bt ? 1 : 0;
    });

    return c.json({ tool_calls: pairs });
  });

  /**
   * GET /api/sessions/:id/commits — commits authored on the local repo
   * during the session window, mined by the CLI at ingest time.
   */
  router.get("/:id/commits", async (c) => {
    const sessionId = c.req.param("id");

    const sessRows = await db
      .select({ id: sessions.id, isPrivate: sessions.isPrivate })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    const sess = sessRows[0];
    if (!sess) return c.json({ error: "session not found" }, 404);
    if (sess.isPrivate) return c.json({ commits: [] });

    const rows = await db
      .select()
      .from(sessionCommits)
      .where(eq(sessionCommits.sessionId, sessionId))
      .orderBy(asc(sessionCommits.authoredAt));

    return c.json({
      commits: rows.map((r) => ({
        sha: r.sha,
        short_sha: r.shortSha,
        author_name: r.authorName,
        author_email: r.authorEmail,
        authored_at: r.authoredAt.toISOString(),
        subject: r.subject,
        branch: r.branch,
        files_changed: r.filesChanged,
        insertions: r.insertions,
        deletions: r.deletions,
      })),
    });
  });

  /**
   * GET /api/sessions/:id/children — subagent (child) sessions launched from
   * this session, hidden from the top-level list. Owner-only RBAC. Mirrors the
   * sibling `:id/events` ownership check. Left-joins the summary for a title.
   */
  router.get("/:id/children", async (c) => {
    const sessionId = c.req.param("id");

    const sessRows = await db
      .select({ id: sessions.id, isPrivate: sessions.isPrivate })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    if (!sessRows[0] || sessRows[0].isPrivate) return c.json({ error: "session not found" }, 404);

    const rows = await db
      .select({
        id: sessions.id,
        name: sessions.name,
        startedAt: sessions.startedAt,
        model: sessions.model,
        totalInputTokens: sessions.totalInputTokens,
        totalOutputTokens: sessions.totalOutputTokens,
        title: summaries.title,
      })
      .from(sessions)
      .leftJoin(summaries, eq(summaries.sessionId, sessions.id))
      .where(and(eq(sessions.parentSessionId, sessionId), eq(sessions.isPrivate, false)))
      .orderBy(asc(sessions.startedAt));

    return c.json({
      children: rows.map((r) => ({
        id: r.id,
        name: r.name,
        started_at: r.startedAt.toISOString(),
        model: r.model,
        total_input_tokens: r.totalInputTokens,
        total_output_tokens: r.totalOutputTokens,
        title: r.title ?? null,
        display_name: r.name ?? r.title ?? `Session ${r.id.slice(0, 8)}`,
      })),
    });
  });

  /**
   * POST /api/sessions/:id/summary — store the LLM summary AND the inline
   * embedding in one transaction (REQ-038). Defense-in-depth redaction is
   * applied to title and summary before they hit the table.
   */
  router.post("/:id/summary", async (c) => {
    const user = c.get("user");
    const sessionId = c.req.param("id");
    const parsed = summarySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const body = parsed.data;
    if (body.session_id !== sessionId) {
      return c.json({ error: "session_id mismatch" }, 400);
    }

    const sessRows = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.id, sessionId), eq(sessions.userId, user.id)))
      .limit(1);
    if (!sessRows[0]) {
      // The provisional-title flow races ingest: the UserPromptSubmit hook can
      // prompt the agent to push a heuristic title before the watcher has
      // ingested any event (which is what creates the session row). For that
      // case only, seed a minimal stub keyed to the authenticated user so the
      // title lands; ingest's onConflictDoUpdate overwrites every placeholder
      // (repoId, agent, timestamps) on the first real event. A non-provisional
      // summary without a row is still a genuine error → keep the 404.
      if (body.model !== "heuristic") {
        return c.json({ error: "session not found" }, 404);
      }
      const seededAt = new Date(body.generated_at);
      await db
        .insert(sessions)
        .values({
          id: sessionId,
          userId: user.id,
          repoId: null,
          agent: "claude-code",
          agentVersion: "unknown",
          sourceCwdHint: "",
          startedAt: seededAt,
          endedAt: seededAt,
        })
        .onConflictDoNothing({ target: sessions.id });
    }

    const safeTitle = ensureString(redactDeep(body.title));
    const safeSummary = ensureString(redactDeep(body.summary));

    // Learnings ride the summary body. We replace the whole set only on an
    // `ok` summary that actually carries `learnings` — an omitted field leaves
    // existing rows untouched (a failed/partial re-run must not wipe good
    // learnings), while `[]` is an explicit "clean session" that clears them.
    const replaceLearnings = body.status === "ok" && body.learnings !== undefined;
    const safeLearnings = (body.learnings ?? []).map((l) => ({
      sessionId,
      title: ensureString(redactDeep(l.title)),
      episodeEventUuids: (redactDeep(l.episode_event_uuids) as unknown[]).map((u) =>
        ensureString(u),
      ),
      whatWentWrong: ensureString(redactDeep(l.what_went_wrong)),
      whatWouldHavePrevented: ensureString(redactDeep(l.what_would_have_prevented)),
      rootCause: l.root_cause,
      attributedTo: l.attributed_to,
      confidence: l.confidence,
      severity: l.severity ?? null,
      model: body.model,
      generatedAt: new Date(body.generated_at),
      summarizedEventCount: body.summarized_event_count ?? null,
    }));

    const provider = getEmbedProvider();
    let vector: number[] | null = null;
    if (body.status === "ok") {
      const embedText = [safeTitle, safeSummary, body.tags.join(" "), body.files_touched.join(" ")]
        .filter((s) => s.length > 0)
        .join(" ");
      vector = await provider.embed(embedText);
    }

    await db.transaction(async (tx) => {
      await tx
        .insert(summaries)
        .values({
          sessionId,
          title: safeTitle,
          summary: safeSummary,
          tags: body.tags,
          filesTouched: body.files_touched,
          prsReferenced: body.prs_referenced,
          toolCallCounts: body.tool_call_counts,
          generatedAt: new Date(body.generated_at),
          model: body.model,
          status: body.status,
          error: body.error ?? null,
          summarizedEventCount: body.summarized_event_count ?? null,
        })
        .onConflictDoUpdate({
          target: summaries.sessionId,
          set: {
            title: safeTitle,
            summary: safeSummary,
            tags: body.tags,
            filesTouched: body.files_touched,
            prsReferenced: body.prs_referenced,
            toolCallCounts: body.tool_call_counts,
            generatedAt: new Date(body.generated_at),
            model: body.model,
            status: body.status,
            error: body.error ?? null,
            summarizedEventCount: body.summarized_event_count ?? null,
          },
        });

      if (vector) {
        await tx
          .insert(embeddings)
          .values({
            sessionId,
            embedding: vector,
            embeddingModel: provider.name,
            version: 1,
          })
          .onConflictDoUpdate({
            target: embeddings.sessionId,
            set: { embedding: vector, embeddingModel: provider.name },
          });
      }

      if (replaceLearnings) {
        await tx.delete(learnings).where(eq(learnings.sessionId, sessionId));
        if (safeLearnings.length > 0) {
          await tx.insert(learnings).values(safeLearnings);
        }
      }
    });

    return c.json({ ok: true, embedded: vector !== null });
  });

  router.post("/:id/summarization-runs", async (c) => {
    const user = c.get("user");
    const sessionId = c.req.param("id");
    const parsed = summarizationRunSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const body = parsed.data;

    const sessRows = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.id, sessionId), eq(sessions.userId, user.id)))
      .limit(1);
    if (!sessRows[0]) return c.json({ error: "session not found" }, 404);

    const inserted = await db
      .insert(summarizationRuns)
      .values({
        sessionId,
        attempt: body.attempt,
        status: body.status,
        startedAt: new Date(body.started_at),
        endedAt: new Date(body.ended_at),
        durationMs: body.duration_ms,
        durationApiMs: body.duration_api_ms ?? null,
        claudeModel: body.claude_model,
        stopReason: body.stop_reason ?? null,
        numTurns: body.num_turns ?? null,
        inputTokens: body.input_tokens,
        outputTokens: body.output_tokens,
        cacheCreationTokens: body.cache_creation_tokens,
        cacheReadTokens: body.cache_read_tokens,
        totalCostUsd: body.total_cost_usd.toString(),
        promptChars: body.prompt_chars,
        truncated: body.truncated,
        error: body.error ?? null,
        rawUsage: (body.raw_usage ?? null) as never,
      })
      .returning({ id: summarizationRuns.id });

    return c.json({ ok: true, id: inserted[0]?.id ?? null });
  });

  /**
   * PUT /api/sessions/:id/blob — store the raw NDJSON bytes. Limit 100MB
   * (REQ-061). Body is consumed as `arrayBuffer` so this works for any
   * `application/x-ndjson` upload.
   */
  router.put("/:id/blob", async (c) => {
    const user = c.get("user");
    const sessionId = c.req.param("id");
    const sessRows = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.id, sessionId), eq(sessions.userId, user.id)))
      .limit(1);
    if (!sessRows[0]) return c.json({ error: "session not found" }, 404);

    const body = await c.req.arrayBuffer();
    if (body.byteLength > MAX_BLOB_BYTES) {
      return c.json({ error: "blob too large" }, 413);
    }
    const bytes = Buffer.from(body);

    await db.transaction(async (tx) => {
      await tx
        .insert(sessionBlobs)
        .values({ sessionId, jsonlBytes: bytes, byteSize: bytes.byteLength })
        .onConflictDoUpdate({
          target: sessionBlobs.sessionId,
          set: {
            jsonlBytes: bytes,
            byteSize: bytes.byteLength,
            uploadedAt: sql`now()`,
          },
        });
      await tx.update(sessions).set({ hasBlob: true }).where(eq(sessions.id, sessionId));
    });
    return c.json({ ok: true, byte_size: bytes.byteLength });
  });

  /**
   * GET /api/sessions/:id/blob — return the original NDJSON bytes
   * byte-for-byte (REQ-062). Writes an audit_log row before responding
   * (REQ-036 generalized to blob reads).
   */
  router.get("/:id/blob", async (c) => {
    const sessionId = c.req.param("id");

    const sessRows = await db
      .select({ id: sessions.id, isPrivate: sessions.isPrivate })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    const sess = sessRows[0];
    if (!sess || sess.isPrivate) return c.json({ error: "session not found" }, 404);

    const blobRows = await db
      .select({
        jsonlBytes: sessionBlobs.jsonlBytes,
        byteSize: sessionBlobs.byteSize,
      })
      .from(sessionBlobs)
      .where(eq(sessionBlobs.sessionId, sessionId))
      .limit(1);
    const blob = blobRows[0];
    if (!blob) return c.json({ error: "blob not found" }, 404);

    await writeAudit(db, c, "read_blob", sessionId);

    const bytes = blob.jsonlBytes;
    // Drizzle's `bytea` custom type returns a Node Buffer; copy into a
    // plain Uint8Array so `Response` doesn't see a SharedArrayBuffer or
    // a slice of the postgres driver's pool buffer.
    const buf = new Uint8Array(bytes.byteLength);
    buf.set(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    return new Response(buf, {
      status: 200,
      headers: {
        "content-type": "application/x-ndjson",
        "content-length": String(blob.byteSize),
      },
    });
  });

  /**
   * POST /api/sessions/:id/artifacts — store one artifact (a file the agent
   * created/edited during the session) as text. Upserts on (session_id, path)
   * so re-pushing is idempotent. Defense-in-depth redaction is applied to the
   * content (the CLI already redacts before upload). Owner-only RBAC.
   */
  router.post("/:id/artifacts", async (c) => {
    const user = c.get("user");
    const sessionId = c.req.param("id");
    const parsed = artifactSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const body = parsed.data;

    const sessRows = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.id, sessionId), eq(sessions.userId, user.id)))
      .limit(1);
    if (!sessRows[0]) return c.json({ error: "session not found" }, 404);

    const safeContent = ensureString(redactDeep(body.content));
    const bytes = Buffer.from(safeContent, "utf8");
    if (bytes.byteLength > MAX_ARTIFACT_BYTES) {
      return c.json({ error: "artifact too large" }, 413);
    }

    const inserted = await db
      .insert(artifacts)
      .values({
        sessionId,
        path: body.path,
        mimeType: body.mime_type,
        bytes,
        byteSize: bytes.byteLength,
      })
      .onConflictDoUpdate({
        target: [artifacts.sessionId, artifacts.path],
        set: {
          mimeType: body.mime_type,
          bytes,
          byteSize: bytes.byteLength,
          uploadedAt: sql`now()`,
        },
      })
      .returning({ id: artifacts.id });

    return c.json({ ok: true, id: inserted[0]?.id ?? null, byte_size: bytes.byteLength });
  });

  /**
   * GET /api/sessions/:id/artifacts — list artifact metadata (no bytes) for
   * the web Artifacts tab. Owner-only RBAC; empty for private sessions.
   */
  router.get("/:id/artifacts", async (c) => {
    const sessionId = c.req.param("id");

    const sessRows = await db
      .select({ id: sessions.id, isPrivate: sessions.isPrivate })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    const sess = sessRows[0];
    if (!sess) return c.json({ error: "session not found" }, 404);
    if (sess.isPrivate) return c.json({ artifacts: [] });

    const rows = await db
      .select({
        id: artifacts.id,
        path: artifacts.path,
        mimeType: artifacts.mimeType,
        byteSize: artifacts.byteSize,
        uploadedAt: artifacts.uploadedAt,
      })
      .from(artifacts)
      .where(eq(artifacts.sessionId, sessionId))
      .orderBy(asc(artifacts.path));

    return c.json({
      artifacts: rows.map((r) => ({
        id: r.id,
        path: r.path,
        mime_type: r.mimeType,
        byte_size: r.byteSize,
        uploaded_at: r.uploadedAt.toISOString(),
      })),
    });
  });

  /**
   * GET /api/sessions/:id/artifacts/:artifactId — return one artifact's text
   * content (decoded utf8) for the web modal viewer. Owner-only RBAC; writes
   * an audit_log row before responding.
   */
  router.get("/:id/artifacts/:artifactId", async (c) => {
    const sessionId = c.req.param("id");
    const artifactId = c.req.param("artifactId");

    const sessRows = await db
      .select({ id: sessions.id, isPrivate: sessions.isPrivate })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    const sess = sessRows[0];
    if (!sess) return c.json({ error: "session not found" }, 404);
    if (sess.isPrivate) return c.json({ error: "artifact not found" }, 404);

    const rows = await db
      .select({
        id: artifacts.id,
        path: artifacts.path,
        mimeType: artifacts.mimeType,
        bytes: artifacts.bytes,
      })
      .from(artifacts)
      .where(and(eq(artifacts.sessionId, sessionId), eq(artifacts.id, artifactId)))
      .limit(1);
    const row = rows[0];
    if (!row) return c.json({ error: "artifact not found" }, 404);

    await writeAudit(db, c, "read_artifact", sessionId, { path: row.path });

    return c.json({
      id: row.id,
      path: row.path,
      mime_type: row.mimeType,
      content: row.bytes.toString("utf8"),
    });
  });

  /**
   * GET /api/sessions/:id — return session metadata + summary, resolved
   * `display_name` (user-set name → LLM title → `Session <prefix>`), and
   * the `is_private` flag. Owner-only RBAC. Writes an audit_log row
   * before responding (REQ-036).
   */
  router.get("/:id", async (c) => {
    const sessionId = c.req.param("id");

    const rows = await db
      .select({
        session: sessions,
        repoCanonicalUrl: repos.canonicalUrl,
        authorLogin: users.githubLogin,
        authorAvatar: users.avatarUrl,
      })
      .from(sessions)
      .leftJoin(repos, eq(repos.id, sessions.repoId))
      .leftJoin(users, eq(users.id, sessions.userId))
      .where(eq(sessions.id, sessionId))
      .limit(1);
    const row = rows[0];
    if (!row) return c.json({ error: "session not found" }, 404);
    const sess = row.session;

    if (sess.isPrivate) {
      await writeAudit(db, c, "read_session", sessionId);
      return c.json({
        id: sess.id,
        is_private: true,
        display_name: "(private)",
      });
    }

    const summaryRows = await db
      .select()
      .from(summaries)
      .where(eq(summaries.sessionId, sessionId))
      .limit(1);
    const summary = summaryRows[0] ?? null;

    const learningRows = await db
      .select()
      .from(learnings)
      .where(eq(learnings.sessionId, sessionId))
      .orderBy(asc(learnings.createdAt));

    const displayName = sess.name ?? summary?.title ?? `Session ${sess.id.slice(0, 8)}`;

    await writeAudit(db, c, "read_session", sessionId);

    return c.json({
      id: sess.id,
      agent: sess.agent,
      agent_version: sess.agentVersion,
      repo_id: sess.repoId,
      repo: row.repoCanonicalUrl
        ? { canonical_url: row.repoCanonicalUrl, branch: sess.branch }
        : null,
      branch: sess.branch,
      source_cwd_hint: sess.sourceCwdHint,
      model: sess.model,
      started_at: sess.startedAt.toISOString(),
      ended_at: sess.endedAt.toISOString(),
      total_input_tokens: sess.totalInputTokens,
      total_output_tokens: sess.totalOutputTokens,
      total_cost_usd: sess.totalCostUsd,
      permission_mode: sess.permissionMode,
      is_private: sess.isPrivate,
      name: sess.name,
      has_blob: sess.hasBlob,
      display_name: displayName,
      author: row.authorLogin
        ? { github_login: row.authorLogin, avatar_url: row.authorAvatar }
        : null,
      summary: summary
        ? {
            title: summary.title,
            summary: summary.summary,
            tags: summary.tags,
            files_touched: summary.filesTouched,
            prs_referenced: summary.prsReferenced,
            tool_call_counts: summary.toolCallCounts,
            status: summary.status,
            summarized_event_count: summary.summarizedEventCount ?? null,
            model: summary.model ?? null,
          }
        : null,
      learnings: learningRows.map((l) => ({
        id: l.id,
        title: l.title,
        episode_event_uuids: l.episodeEventUuids,
        what_went_wrong: l.whatWentWrong,
        what_would_have_prevented: l.whatWouldHavePrevented,
        root_cause: l.rootCause,
        attributed_to: l.attributedTo,
        confidence: l.confidence,
        severity: l.severity ?? null,
        model: l.model ?? null,
        generated_at: l.generatedAt ? l.generatedAt.toISOString() : null,
        summarized_event_count: l.summarizedEventCount ?? null,
      })),
    });
  });

  /**
   * PATCH /api/sessions/:id — update `name` and/or `is_private`. Owner-only.
   *
   * `is_private: true` triggers a hard scrub: events, summary, embedding,
   * and blob rows are deleted; only the `sessions` row remains so audit
   * entries continue to FK-resolve. We always write an audit_log row
   * (`marked_private` for the privacy flip, `renamed` for name changes).
   */
  router.patch("/:id", async (c) => {
    const user = c.get("user");
    const sessionId = c.req.param("id");

    const parsed = patchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const body = parsed.data;
    if (body.name === undefined && body.is_private === undefined) {
      return c.json({ error: "no fields to update" }, 400);
    }

    const rows = await db
      .select({ id: sessions.id, isPrivate: sessions.isPrivate })
      .from(sessions)
      .where(and(eq(sessions.id, sessionId), eq(sessions.userId, user.id)))
      .limit(1);
    const sess = rows[0];
    if (!sess) return c.json({ error: "session not found" }, 404);

    await db.transaction(async (tx) => {
      if (body.name !== undefined) {
        await tx
          .update(sessions)
          .set({ name: body.name, updatedAt: sql`now()` })
          .where(eq(sessions.id, sessionId));
      }
      if (body.is_private === true) {
        await tx.delete(events).where(eq(events.sessionId, sessionId));
        await tx.delete(summaries).where(eq(summaries.sessionId, sessionId));
        await tx.delete(embeddings).where(eq(embeddings.sessionId, sessionId));
        await tx.delete(sessionBlobs).where(eq(sessionBlobs.sessionId, sessionId));
        await tx.delete(artifacts).where(eq(artifacts.sessionId, sessionId));
        await tx
          .update(sessions)
          .set({ isPrivate: true, hasBlob: false, updatedAt: sql`now()` })
          .where(eq(sessions.id, sessionId));
      } else if (body.is_private === false) {
        await tx
          .update(sessions)
          .set({ isPrivate: false, updatedAt: sql`now()` })
          .where(eq(sessions.id, sessionId));
      }
    });

    if (body.is_private === true) {
      await writeAudit(db, c, "marked_private", sessionId);
    } else if (body.is_private === false) {
      await writeAudit(db, c, "marked_public", sessionId);
    }
    if (body.name !== undefined) {
      await writeAudit(db, c, "renamed", sessionId, { name: body.name });
    }

    return c.json({ ok: true });
  });

  return router;
};
