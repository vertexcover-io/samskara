// AI-generated. See PROMPT.md for the prompts and model used.

import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { Db } from "../src/db/client.js";
import {
  events,
  artifacts,
  auditLog,
  embeddings,
  learnings,
  sessionBlobs,
  sessions,
  summaries,
} from "../src/db/schema.js";
import { resetEmbedProvider } from "../src/embed/index.js";
import type { Env } from "../src/env.js";
import { type TestPgHandle, startTestPostgres, truncateAll } from "./helpers/pg-test-container.js";
import { seedUser } from "./helpers/seed.js";

const TEST_ENV: Env = {
  DATABASE_URL: "",
  JWT_SECRET: "test-secret-test-secret-test",
  EMBED_PROVIDER: "fake",
  OPENAI_EMBED_MODEL: "text-embedding-3-small",
  PORT: 0,
  NODE_ENV: "test",
  GITHUB_ORG: "test-org",
};

let pg: TestPgHandle;
let db: Db;
let app: Hono;
let env: Env;

const insertSession = async (sessionId: string, userId: string, repoId: string): Promise<void> => {
  await db.db.insert(sessions).values({
    id: sessionId,
    userId,
    repoId,
    agent: "claude-code",
    agentVersion: "1.0.0",
    branch: "main",
    sourceCwdHint: "/tmp/work",
    model: "claude-3-5-sonnet",
    permissionMode: "default",
    startedAt: new Date("2026-05-01T10:00:00.000Z"),
    endedAt: new Date("2026-05-01T10:30:00.000Z"),
    totalInputTokens: 100,
    totalOutputTokens: 50,
    totalCostUsd: "0.01",
  });
};

beforeAll(async () => {
  process.env.EMBED_PROVIDER = "fake";
  resetEmbedProvider();
  pg = await startTestPostgres();
  db = pg.db;
  env = { ...TEST_ENV, DATABASE_URL: pg.url };
  app = buildApp(db.db, env);
}, 180_000);

afterAll(async () => {
  await pg.stop();
  resetEmbedProvider();
});

beforeEach(async () => {
  await truncateAll(db);
});

const post = async (path: string, token: string, body: unknown): Promise<Response> =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

const put = async (path: string, token: string, bytes: Uint8Array): Promise<Response> =>
  app.request(path, {
    method: "PUT",
    headers: {
      "content-type": "application/x-ndjson",
      authorization: `Bearer ${token}`,
    },
    body: bytes,
  });

const get = async (path: string, token: string): Promise<Response> =>
  app.request(path, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });

const buildSummaryBody = (sessionId: string): Record<string, unknown> => ({
  session_id: sessionId,
  title: "Phase 4 summarizer wiring",
  summary:
    "Wired the CLI summarizer to detect session-end and POST the result to the server, which generates an embedding inline. The server upserts the summary row alongside the embedding row in a single transaction so search is immediately consistent. PR mining mines URLs from gh pr create / git push tool outputs and falls back to gh pr list.",
  tags: ["phase-4", "summarizer", "embedding"],
  files_touched: [
    "packages/cli/src/summarizer/pipeline.ts",
    "packages/server/src/routes/sessions.ts",
  ],
  prs_referenced: [],
  tool_call_counts: { Bash: 3, Read: 7, Write: 2 },
  generated_at: "2026-05-09T12:00:00.000Z",
  model: "sonnet",
  status: "ok",
});

describe("POST /api/sessions/:id/summary", () => {
  it("REQ-038: stores summary AND embedding inline before responding 200", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "summ-1@example.test",
      repoUrl: "github.com/example/summary-1",
    });
    const sessionId = "session-summary-1";
    await insertSession(sessionId, seed.user.id, seed.repoId);

    const res = await post(
      `/api/sessions/${sessionId}/summary`,
      seed.token,
      buildSummaryBody(sessionId),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; embedded: boolean };
    expect(json.ok).toBe(true);
    expect(json.embedded).toBe(true);

    // Both rows must exist by the time the response is returned.
    const summaryRows = await db.db
      .select()
      .from(summaries)
      .where(eq(summaries.sessionId, sessionId));
    expect(summaryRows).toHaveLength(1);
    expect(summaryRows[0]?.status).toBe("ok");
    expect(summaryRows[0]?.title).toBe("Phase 4 summarizer wiring");
    expect(summaryRows[0]?.tags).toEqual(["phase-4", "summarizer", "embedding"]);

    const embedRows = await db.db
      .select()
      .from(embeddings)
      .where(eq(embeddings.sessionId, sessionId));
    expect(embedRows).toHaveLength(1);
    const vec = embedRows[0]?.embedding ?? [];
    expect(vec).toHaveLength(1536);
    const sumSq = vec.reduce((acc, v) => acc + v * v, 0);
    expect(sumSq).toBeGreaterThan(0);
  });

  it("redacts secrets in title and summary (defense-in-depth REQ-034)", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "summ-redact@example.test",
      repoUrl: "github.com/example/summary-redact",
    });
    const sessionId = "session-summary-redact";
    await insertSession(sessionId, seed.user.id, seed.repoId);

    const body = buildSummaryBody(sessionId);
    body.title = "leaked AKIA0123456789ABCDEF in the title";
    body.summary = "no secret here, but consider AKIA9876543210FEDCBA happened.";

    const res = await post(`/api/sessions/${sessionId}/summary`, seed.token, body);
    expect(res.status).toBe(200);

    const row = (await db.db.select().from(summaries).where(eq(summaries.sessionId, sessionId)))[0];
    expect(row?.title).not.toContain("AKIA0123456789ABCDEF");
    expect(row?.title).toContain("[REDACTED:");
    expect(row?.summary).not.toContain("AKIA9876543210FEDCBA");
    expect(row?.summary).toContain("[REDACTED:");
  });

  it("404 when the session does not exist for this user", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "summ-404@example.test",
      repoUrl: "github.com/example/summary-404",
    });
    const res = await post(
      "/api/sessions/missing-session/summary",
      seed.token,
      buildSummaryBody("missing-session"),
    );
    expect(res.status).toBe(404);
  });

  it("auto-creates a stub session for a provisional (heuristic) summary that races ahead of ingest", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "summ-provisional@example.test",
      repoUrl: "github.com/example/summary-provisional",
    });
    const sessionId = "session-provisional-race";
    const body = buildSummaryBody(sessionId);
    body.model = "heuristic";

    const res = await post(`/api/sessions/${sessionId}/summary`, seed.token, body);
    expect(res.status).toBe(200);

    const sessRows = await db.db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(sessRows).toHaveLength(1);
    expect(sessRows[0]?.userId).toBe(seed.user.id);
    expect(sessRows[0]?.repoId).toBeNull();

    const getRes = await get(`/api/sessions/${sessionId}`, seed.token);
    expect(getRes.status).toBe(200);
    const json = (await getRes.json()) as { summary: { title: string } | null };
    expect(json.summary?.title).toBe("Phase 4 summarizer wiring");
  });

  it("still 404s for a non-provisional summary that races ahead of ingest", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "summ-nonprovisional@example.test",
      repoUrl: "github.com/example/summary-nonprovisional",
    });
    const sessionId = "session-nonprovisional-race";
    const body = buildSummaryBody(sessionId);
    body.model = "agent";

    const res = await post(`/api/sessions/${sessionId}/summary`, seed.token, body);
    expect(res.status).toBe(404);
  });

  it("REQ-007/REQ-014: round-trips summarized_event_count via POST and GET /:id", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "summ-watermark@example.test",
      repoUrl: "github.com/example/summary-watermark",
    });
    const sessionId = "session-summary-watermark";
    await insertSession(sessionId, seed.user.id, seed.repoId);

    const body = buildSummaryBody(sessionId);
    body.summarized_event_count = 42;

    const postRes = await post(`/api/sessions/${sessionId}/summary`, seed.token, body);
    expect(postRes.status).toBe(200);

    const getRes = await get(`/api/sessions/${sessionId}`, seed.token);
    expect(getRes.status).toBe(200);
    const json = (await getRes.json()) as {
      summary: { summarized_event_count: number | null } | null;
    };
    expect(json.summary?.summarized_event_count).toBe(42);
  });

  it("round-trips summary model (e.g. provisional heuristic) via POST and GET /:id", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "summ-model@example.test",
      repoUrl: "github.com/example/summary-model",
    });
    const sessionId = "session-summary-model";
    await insertSession(sessionId, seed.user.id, seed.repoId);

    const body = buildSummaryBody(sessionId);
    body.model = "heuristic";

    const postRes = await post(`/api/sessions/${sessionId}/summary`, seed.token, body);
    expect(postRes.status).toBe(200);

    const getRes = await get(`/api/sessions/${sessionId}`, seed.token);
    expect(getRes.status).toBe(200);
    const json = (await getRes.json()) as { summary: { model: string | null } | null };
    expect(json.summary?.model).toBe("heuristic");
  });

  it("REQ-007/REQ-014: omitting summarized_event_count yields null on GET", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "summ-watermark-null@example.test",
      repoUrl: "github.com/example/summary-watermark-null",
    });
    const sessionId = "session-summary-watermark-null";
    await insertSession(sessionId, seed.user.id, seed.repoId);

    const postRes = await post(
      `/api/sessions/${sessionId}/summary`,
      seed.token,
      buildSummaryBody(sessionId),
    );
    expect(postRes.status).toBe(200);

    const getRes = await get(`/api/sessions/${sessionId}`, seed.token);
    expect(getRes.status).toBe(200);
    const json = (await getRes.json()) as {
      summary: { summarized_event_count: number | null } | null;
    };
    expect(json.summary?.summarized_event_count).toBeNull();
  });

  it("skips embedding generation when status='failed'", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "summ-failed@example.test",
      repoUrl: "github.com/example/summary-failed",
    });
    const sessionId = "session-summary-failed";
    await insertSession(sessionId, seed.user.id, seed.repoId);

    const body = buildSummaryBody(sessionId);
    body.status = "failed";
    body.error = "claude binary returned rc=1";

    const res = await post(`/api/sessions/${sessionId}/summary`, seed.token, body);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { embedded: boolean };
    expect(json.embedded).toBe(false);

    const embedRows = await db.db
      .select()
      .from(embeddings)
      .where(eq(embeddings.sessionId, sessionId));
    expect(embedRows).toHaveLength(0);
  });
});

describe("learnings on POST /api/sessions/:id/summary + GET /:id", () => {
  const aLearning = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    title: "Marked done without running tests",
    episode_event_uuids: ["u-3", "u-6"],
    what_went_wrong: "Reported the work finished before running any tests.",
    what_would_have_prevented: "Run the suite and read the result before reporting done.",
    root_cause: "missing_verification",
    attributed_to: "agent",
    confidence: 0.95,
    severity: "high",
    ...over,
  });

  const rowsFor = (sessionId: string) =>
    db.db.select().from(learnings).where(eq(learnings.sessionId, sessionId));

  it("inserts learnings, stamps provenance, and returns them via GET", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "learn-1@example.test",
      repoUrl: "github.com/example/learn-1",
    });
    const sessionId = "session-learn-1";
    await insertSession(sessionId, seed.user.id, seed.repoId);

    const body = buildSummaryBody(sessionId);
    body.summarized_event_count = 47;
    body.learnings = [aLearning()];
    const res = await post(`/api/sessions/${sessionId}/summary`, seed.token, body);
    expect(res.status).toBe(200);

    const rows = await rowsFor(sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.rootCause).toBe("missing_verification");
    expect(rows[0]?.model).toBe("sonnet");
    expect(rows[0]?.summarizedEventCount).toBe(47);

    const getRes = await get(`/api/sessions/${sessionId}`, seed.token);
    const json = (await getRes.json()) as {
      learnings: Array<{ root_cause: string; episode_event_uuids: string[] }>;
    };
    expect(json.learnings).toHaveLength(1);
    expect(json.learnings[0]?.root_cause).toBe("missing_verification");
    expect(json.learnings[0]?.episode_event_uuids).toEqual(["u-3", "u-6"]);
  });

  it("delete-and-replaces on re-push (no duplicates)", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "learn-replace@example.test",
      repoUrl: "github.com/example/learn-replace",
    });
    const sessionId = "session-learn-replace";
    await insertSession(sessionId, seed.user.id, seed.repoId);

    const body = buildSummaryBody(sessionId);
    body.learnings = [aLearning(), aLearning({ title: "Second" })];
    await post(`/api/sessions/${sessionId}/summary`, seed.token, body);
    expect(await rowsFor(sessionId)).toHaveLength(2);

    body.learnings = [aLearning({ title: "Only one now" })];
    await post(`/api/sessions/${sessionId}/summary`, seed.token, body);
    const rows = await rowsFor(sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("Only one now");
  });

  it("clears learnings when an empty array is pushed", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "learn-clear@example.test",
      repoUrl: "github.com/example/learn-clear",
    });
    const sessionId = "session-learn-clear";
    await insertSession(sessionId, seed.user.id, seed.repoId);

    const body = buildSummaryBody(sessionId);
    body.learnings = [aLearning()];
    await post(`/api/sessions/${sessionId}/summary`, seed.token, body);
    expect(await rowsFor(sessionId)).toHaveLength(1);

    body.learnings = [];
    await post(`/api/sessions/${sessionId}/summary`, seed.token, body);
    expect(await rowsFor(sessionId)).toHaveLength(0);
  });

  it("leaves existing learnings untouched when the field is omitted", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "learn-omit@example.test",
      repoUrl: "github.com/example/learn-omit",
    });
    const sessionId = "session-learn-omit";
    await insertSession(sessionId, seed.user.id, seed.repoId);

    const body = buildSummaryBody(sessionId);
    body.learnings = [aLearning()];
    await post(`/api/sessions/${sessionId}/summary`, seed.token, body);

    const without = buildSummaryBody(sessionId);
    // no learnings field
    await post(`/api/sessions/${sessionId}/summary`, seed.token, without);
    expect(await rowsFor(sessionId)).toHaveLength(1);
  });

  it("does not wipe learnings on a failed summary re-run", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "learn-failed@example.test",
      repoUrl: "github.com/example/learn-failed",
    });
    const sessionId = "session-learn-failed";
    await insertSession(sessionId, seed.user.id, seed.repoId);

    const ok = buildSummaryBody(sessionId);
    ok.learnings = [aLearning()];
    await post(`/api/sessions/${sessionId}/summary`, seed.token, ok);

    const failed = buildSummaryBody(sessionId);
    failed.status = "failed";
    failed.learnings = [];
    await post(`/api/sessions/${sessionId}/summary`, seed.token, failed);
    expect(await rowsFor(sessionId)).toHaveLength(1);
  });

  it("redacts secrets in learning text fields", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "learn-redact@example.test",
      repoUrl: "github.com/example/learn-redact",
    });
    const sessionId = "session-learn-redact";
    await insertSession(sessionId, seed.user.id, seed.repoId);

    const body = buildSummaryBody(sessionId);
    body.learnings = [
      aLearning({ what_went_wrong: "leaked AKIA9876543210FEDCBA in the log output." }),
    ];
    await post(`/api/sessions/${sessionId}/summary`, seed.token, body);
    const rows = await rowsFor(sessionId);
    expect(rows[0]?.whatWentWrong).not.toContain("AKIA9876543210FEDCBA");
    expect(rows[0]?.whatWentWrong).toContain("[REDACTED:");
  });

  it("rejects a learning with no evidence uuids (400)", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "learn-bad@example.test",
      repoUrl: "github.com/example/learn-bad",
    });
    const sessionId = "session-learn-bad";
    await insertSession(sessionId, seed.user.id, seed.repoId);

    const body = buildSummaryBody(sessionId);
    body.learnings = [aLearning({ episode_event_uuids: [] })];
    const res = await post(`/api/sessions/${sessionId}/summary`, seed.token, body);
    expect(res.status).toBe(400);
  });
});

describe("PUT /api/sessions/:id/blob (REQ-061) and GET (REQ-062)", () => {
  it("byte-for-byte round-trip via PUT then GET", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "blob-rt@example.test",
      repoUrl: "github.com/example/blob-rt",
    });
    const sessionId = "session-blob-rt";
    await insertSession(sessionId, seed.user.id, seed.repoId);

    const ndjson = [
      JSON.stringify({ type: "user", uuid: "1", text: "hello" }),
      JSON.stringify({ type: "assistant", uuid: "2", text: "hi" }),
      "",
    ].join("\n");
    const original = new TextEncoder().encode(ndjson);

    const putRes = await put(`/api/sessions/${sessionId}/blob`, seed.token, original);
    expect(putRes.status).toBe(200);
    const putJson = (await putRes.json()) as { ok: boolean; byte_size: number };
    expect(putJson.byte_size).toBe(original.byteLength);

    // sessions.has_blob flipped
    const sessRow = await db.db
      .select({ hasBlob: sessions.hasBlob })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    expect(sessRow[0]?.hasBlob).toBe(true);

    const getRes = await get(`/api/sessions/${sessionId}/blob`, seed.token);
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get("content-type")).toBe("application/x-ndjson");
    expect(getRes.headers.get("content-length")).toBe(String(original.byteLength));
    const got = new Uint8Array(await getRes.arrayBuffer());
    expect(got.byteLength).toBe(original.byteLength);
    expect(Buffer.from(got).equals(Buffer.from(original))).toBe(true);
  });

  it("global reads: another user CAN GET the blob (200)", async () => {
    const a = await seedUser(db.db, env.JWT_SECRET, {
      githubLogin: "blob-rbac-a",
      repoUrl: "github.com/example/blob-rbac-a",
    });
    const b = await seedUser(db.db, env.JWT_SECRET, {
      githubLogin: "blob-rbac-b",
      repoUrl: "github.com/example/blob-rbac-b",
    });
    const sessionId = "session-blob-rbac";
    await insertSession(sessionId, a.user.id, a.repoId);
    await put(
      `/api/sessions/${sessionId}/blob`,
      a.token,
      new TextEncoder().encode("shared bytes\n"),
    );

    const res = await get(`/api/sessions/${sessionId}/blob`, b.token);
    expect(res.status).toBe(200);
  });

  it("audit_log row written on GET", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "blob-audit@example.test",
      repoUrl: "github.com/example/blob-audit",
    });
    const sessionId = "session-blob-audit";
    await insertSession(sessionId, seed.user.id, seed.repoId);
    await put(
      `/api/sessions/${sessionId}/blob`,
      seed.token,
      new TextEncoder().encode("audit me\n"),
    );

    const before = await db.db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(eq(auditLog.targetSessionId, sessionId));
    expect(before.length).toBe(0);

    const res = await get(`/api/sessions/${sessionId}/blob`, seed.token);
    expect(res.status).toBe(200);
    await res.arrayBuffer();

    const after = await db.db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.targetSessionId, sessionId));
    expect(after.length).toBe(1);
    expect(after[0]?.action).toBe("read_blob");
  });

  it("PUT then re-PUT replaces the bytes (idempotent overwrite)", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "blob-overwrite@example.test",
      repoUrl: "github.com/example/blob-overwrite",
    });
    const sessionId = "session-blob-overwrite";
    await insertSession(sessionId, seed.user.id, seed.repoId);

    const v1 = new TextEncoder().encode("v1 content\n");
    const v2 = new TextEncoder().encode("v2 different and longer content here\n");
    await put(`/api/sessions/${sessionId}/blob`, seed.token, v1);
    await put(`/api/sessions/${sessionId}/blob`, seed.token, v2);

    const got = new Uint8Array(
      await (await get(`/api/sessions/${sessionId}/blob`, seed.token)).arrayBuffer(),
    );
    expect(Buffer.from(got).toString("utf8")).toBe("v2 different and longer content here\n");
  });
});

const patch = async (path: string, token: string, body: unknown): Promise<Response> =>
  app.request(path, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

describe("GET /api/sessions/:id (REQ-036, REQ-059)", () => {
  it("returns session metadata + summary with display_name resolution", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "get-meta@example.test",
      repoUrl: "github.com/example/get-meta",
    });
    const sessionId = "session-get-meta";
    await insertSession(sessionId, seed.user.id, seed.repoId);
    // Seed a summary with title only — no user-set name yet.
    await db.db.insert(summaries).values({
      sessionId,
      title: "auto-generated title",
      summary: "summary body",
      tags: ["a"],
      filesTouched: ["x.ts"],
      prsReferenced: [],
      toolCallCounts: { Bash: 1 },
      generatedAt: new Date(),
      model: "sonnet",
      status: "ok",
    });

    const r1 = await get(`/api/sessions/${sessionId}`, seed.token);
    expect(r1.status).toBe(200);
    const j1 = (await r1.json()) as { display_name: string; summary: { title: string } };
    expect(j1.display_name).toBe("auto-generated title");
    expect(j1.summary?.title).toBe("auto-generated title");

    // Set a user-set name → should win over title.
    await patch(`/api/sessions/${sessionId}`, seed.token, { name: "user override" });
    const r2 = await get(`/api/sessions/${sessionId}`, seed.token);
    const j2 = (await r2.json()) as { display_name: string; name: string | null };
    expect(j2.display_name).toBe("user override");
    expect(j2.name).toBe("user override");

    // Clear name → falls back to title.
    await patch(`/api/sessions/${sessionId}`, seed.token, { name: null });
    const r3 = await get(`/api/sessions/${sessionId}`, seed.token);
    const j3 = (await r3.json()) as { display_name: string; name: string | null };
    expect(j3.name).toBeNull();
    expect(j3.display_name).toBe("auto-generated title");
  });

  it("REQ-059: display_name falls back to `Session <prefix>` when neither name nor title exist", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "fallback@example.test",
      repoUrl: "github.com/example/fallback",
    });
    const sessionId = "abcd1234-fallback";
    await insertSession(sessionId, seed.user.id, seed.repoId);
    const r = await get(`/api/sessions/${sessionId}`, seed.token);
    const j = (await r.json()) as { display_name: string };
    expect(j.display_name).toBe(`Session ${sessionId.slice(0, 8)}`);
  });

  it("REQ-036: GET writes one audit_log row with action=read_session", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "audit-get@example.test",
      repoUrl: "github.com/example/audit-get",
    });
    const sessionId = "session-audit-get";
    await insertSession(sessionId, seed.user.id, seed.repoId);
    const before = await db.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetSessionId, sessionId));
    expect(before.length).toBe(0);
    const r = await get(`/api/sessions/${sessionId}`, seed.token);
    expect(r.status).toBe(200);
    const after = await db.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetSessionId, sessionId));
    expect(after.length).toBe(1);
    expect(after[0]?.action).toBe("read_session");
  });

  it("global reads: another user CAN GET the session detail (200)", async () => {
    const a = await seedUser(db.db, env.JWT_SECRET, {
      githubLogin: "rbac-a",
      repoUrl: "github.com/example/rbac-a",
    });
    const b = await seedUser(db.db, env.JWT_SECRET, {
      githubLogin: "rbac-b",
      repoUrl: "github.com/example/rbac-b",
    });
    const sessionId = "session-rbac-cross";
    await insertSession(sessionId, a.user.id, a.repoId);
    const r = await get(`/api/sessions/${sessionId}`, b.token);
    expect(r.status).toBe(200);
  });
});

describe("PATCH /api/sessions/:id name (REQ-059, REQ-060)", () => {
  it("sets and clears name", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "name@example.test",
      repoUrl: "github.com/example/name",
    });
    const sessionId = "session-name-1";
    await insertSession(sessionId, seed.user.id, seed.repoId);

    const r1 = await patch(`/api/sessions/${sessionId}`, seed.token, { name: "my fork" });
    expect(r1.status).toBe(200);
    const row1 = (await db.db.select().from(sessions).where(eq(sessions.id, sessionId)))[0];
    expect(row1?.name).toBe("my fork");

    const r2 = await patch(`/api/sessions/${sessionId}`, seed.token, { name: null });
    expect(r2.status).toBe(200);
    const row2 = (await db.db.select().from(sessions).where(eq(sessions.id, sessionId)))[0];
    expect(row2?.name).toBeNull();
  });

  it("400 with no fields", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "patch-empty@example.test",
      repoUrl: "github.com/example/patch-empty",
    });
    const sessionId = "session-patch-empty";
    await insertSession(sessionId, seed.user.id, seed.repoId);
    const r = await patch(`/api/sessions/${sessionId}`, seed.token, {});
    expect(r.status).toBe(400);
  });

  it("404 for another user's session (RBAC)", async () => {
    const a = await seedUser(db.db, env.JWT_SECRET, {
      email: "patch-rbac-a@example.test",
      repoUrl: "github.com/example/patch-rbac-a",
    });
    const b = await seedUser(db.db, env.JWT_SECRET, {
      email: "patch-rbac-b@example.test",
      repoUrl: "github.com/example/patch-rbac-b",
    });
    const sessionId = "session-patch-rbac";
    await insertSession(sessionId, a.user.id, a.repoId);
    const r = await patch(`/api/sessions/${sessionId}`, b.token, { name: "intruder" });
    expect(r.status).toBe(404);
  });
});

describe("PATCH /api/sessions/:id privacy (REQ-039, EDGE-018)", () => {
  it("is_private=true cascades: deletes events/summary/embedding/blob and keeps sessions row", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "priv@example.test",
      repoUrl: "github.com/example/priv",
    });
    const sessionId = "session-priv-1";
    await insertSession(sessionId, seed.user.id, seed.repoId);
    // Seed events, summary, embedding, blob.
    await db.db.insert(events).values({
      sessionId,
      eventUuid: "ev-1",
      parentUuid: null,
      ts: new Date(),
      type: "user_msg",
      payload: { text: "secret" },
    });
    await db.db.insert(summaries).values({
      sessionId,
      title: "t",
      summary: "s",
      tags: [],
      filesTouched: [],
      prsReferenced: [],
      toolCallCounts: {},
      generatedAt: new Date(),
      model: "sonnet",
      status: "ok",
    });
    await db.db.insert(embeddings).values({
      sessionId,
      embedding: new Array(1536).fill(0.01),
      embeddingModel: "fake",
      version: 1,
    });
    await db.db.insert(sessionBlobs).values({
      sessionId,
      jsonlBytes: Buffer.from("hello\n"),
      byteSize: 6,
    });

    const r = await patch(`/api/sessions/${sessionId}`, seed.token, { is_private: true });
    expect(r.status).toBe(200);

    const sessRow = (await db.db.select().from(sessions).where(eq(sessions.id, sessionId)))[0];
    expect(sessRow?.isPrivate).toBe(true);
    expect(sessRow?.hasBlob).toBe(false);

    expect(await db.db.select().from(events).where(eq(events.sessionId, sessionId))).toHaveLength(
      0,
    );
    expect(
      await db.db.select().from(summaries).where(eq(summaries.sessionId, sessionId)),
    ).toHaveLength(0);
    expect(
      await db.db.select().from(embeddings).where(eq(embeddings.sessionId, sessionId)),
    ).toHaveLength(0);
    expect(
      await db.db.select().from(sessionBlobs).where(eq(sessionBlobs.sessionId, sessionId)),
    ).toHaveLength(0);

    // Audit log row.
    const audits = await db.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetSessionId, sessionId));
    const actions = audits.map((a) => a.action);
    expect(actions).toContain("marked_private");
  });

  it("is_private=true session subsequently GETs as a placeholder (owner only)", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "priv-get@example.test",
      repoUrl: "github.com/example/priv-get",
    });
    const sessionId = "session-priv-get";
    await insertSession(sessionId, seed.user.id, seed.repoId);
    await patch(`/api/sessions/${sessionId}`, seed.token, { is_private: true });
    const r = await get(`/api/sessions/${sessionId}`, seed.token);
    expect(r.status).toBe(200);
    const j = (await r.json()) as { is_private: boolean; display_name: string };
    expect(j.is_private).toBe(true);
    expect(j.display_name).toBe("(private)");
  });

  it("is_private=false unsets the flag without recreating data", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "unpriv@example.test",
      repoUrl: "github.com/example/unpriv",
    });
    const sessionId = "session-unpriv";
    await insertSession(sessionId, seed.user.id, seed.repoId);
    await patch(`/api/sessions/${sessionId}`, seed.token, { is_private: true });
    const r = await patch(`/api/sessions/${sessionId}`, seed.token, { is_private: false });
    expect(r.status).toBe(200);
    const row = (await db.db.select().from(sessions).where(eq(sessions.id, sessionId)))[0];
    expect(row?.isPrivate).toBe(false);
  });
});

describe("artifacts: POST + GET list + GET one", () => {
  const postArtifact = (
    sessionId: string,
    token: string,
    body: { path: string; mime_type: string; content: string },
  ): Promise<Response> => post(`/api/sessions/${sessionId}/artifacts`, token, body);

  it("upserts on (session_id, path): re-push updates, does not duplicate", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "artifact-upsert@example.test",
      repoUrl: "github.com/example/artifact-upsert",
    });
    const sessionId = "session-artifact-upsert";
    await insertSession(sessionId, seed.user.id, seed.repoId);

    const r1 = await postArtifact(sessionId, seed.token, {
      path: "docs/report.md",
      mime_type: "text/markdown",
      content: "# v1",
    });
    expect(r1.status).toBe(200);
    const r2 = await postArtifact(sessionId, seed.token, {
      path: "docs/report.md",
      mime_type: "text/markdown",
      content: "# v2 longer content",
    });
    expect(r2.status).toBe(200);

    const rows = await db.db.select().from(artifacts).where(eq(artifacts.sessionId, sessionId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.bytes.toString("utf8")).toBe("# v2 longer content");
  });

  it("lists artifact metadata (no bytes) for the session", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "artifact-list@example.test",
      repoUrl: "github.com/example/artifact-list",
    });
    const sessionId = "session-artifact-list";
    await insertSession(sessionId, seed.user.id, seed.repoId);

    await postArtifact(sessionId, seed.token, {
      path: "b.txt",
      mime_type: "text/plain",
      content: "bbb",
    });
    await postArtifact(sessionId, seed.token, {
      path: "a.md",
      mime_type: "text/markdown",
      content: "# a",
    });

    const res = await get(`/api/sessions/${sessionId}/artifacts`, seed.token);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      artifacts: Array<{ id: string; path: string; mime_type: string; byte_size: number }>;
    };
    expect(json.artifacts).toHaveLength(2);
    // ordered by path
    expect(json.artifacts.map((a) => a.path)).toEqual(["a.md", "b.txt"]);
    expect(json.artifacts[0]?.mime_type).toBe("text/markdown");
    expect(json.artifacts[0]?.byte_size).toBe(3);
  });

  it("fetches one artifact's decoded content and writes a read_artifact audit row", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "artifact-fetch@example.test",
      repoUrl: "github.com/example/artifact-fetch",
    });
    const sessionId = "session-artifact-fetch";
    await insertSession(sessionId, seed.user.id, seed.repoId);

    await postArtifact(sessionId, seed.token, {
      path: "notes.md",
      mime_type: "text/markdown",
      content: "# Heading\n\nbody",
    });
    const listed = (await (
      await get(`/api/sessions/${sessionId}/artifacts`, seed.token)
    ).json()) as { artifacts: Array<{ id: string }> };
    const artifactId = listed.artifacts[0]?.id ?? "";

    const res = await get(`/api/sessions/${sessionId}/artifacts/${artifactId}`, seed.token);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { path: string; mime_type: string; content: string };
    expect(json.path).toBe("notes.md");
    expect(json.content).toBe("# Heading\n\nbody");

    const audits = await db.db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.targetSessionId, sessionId));
    expect(audits.map((a) => a.action)).toContain("read_artifact");
  });

  it("redacts secrets in artifact content (defense-in-depth)", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "artifact-redact@example.test",
      repoUrl: "github.com/example/artifact-redact",
    });
    const sessionId = "session-artifact-redact";
    await insertSession(sessionId, seed.user.id, seed.repoId);

    await postArtifact(sessionId, seed.token, {
      path: "leak.txt",
      mime_type: "text/plain",
      content: "key is AKIA0123456789ABCDEF here",
    });
    const row = (await db.db.select().from(artifacts).where(eq(artifacts.sessionId, sessionId)))[0];
    expect(row?.bytes.toString("utf8")).not.toContain("AKIA0123456789ABCDEF");
    expect(row?.bytes.toString("utf8")).toContain("[REDACTED:");
  });

  it("413 when content exceeds the per-artifact cap", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "artifact-big@example.test",
      repoUrl: "github.com/example/artifact-big",
    });
    const sessionId = "session-artifact-big";
    await insertSession(sessionId, seed.user.id, seed.repoId);

    const huge = "x".repeat(5 * 1024 * 1024 + 1);
    const res = await postArtifact(sessionId, seed.token, {
      path: "huge.txt",
      mime_type: "text/plain",
      content: huge,
    });
    expect(res.status).toBe(413);
  });

  it("another user CANNOT POST artifacts (404) but CAN list them (global reads)", async () => {
    const a = await seedUser(db.db, env.JWT_SECRET, {
      githubLogin: "artifact-rbac-a",
      repoUrl: "github.com/example/artifact-rbac-a",
    });
    const b = await seedUser(db.db, env.JWT_SECRET, {
      githubLogin: "artifact-rbac-b",
      repoUrl: "github.com/example/artifact-rbac-b",
    });
    const sessionId = "session-artifact-rbac";
    await insertSession(sessionId, a.user.id, a.repoId);
    await postArtifact(sessionId, a.token, {
      path: "a.md",
      mime_type: "text/markdown",
      content: "# a",
    });

    // Write stays owner-only.
    expect(
      (
        await postArtifact(sessionId, b.token, {
          path: "x.md",
          mime_type: "text/markdown",
          content: "x",
        })
      ).status,
    ).toBe(404);
    // Read is global.
    expect((await get(`/api/sessions/${sessionId}/artifacts`, b.token)).status).toBe(200);
  });

  it("is_private=true scrub deletes artifacts", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "artifact-priv@example.test",
      repoUrl: "github.com/example/artifact-priv",
    });
    const sessionId = "session-artifact-priv";
    await insertSession(sessionId, seed.user.id, seed.repoId);
    await postArtifact(sessionId, seed.token, {
      path: "a.md",
      mime_type: "text/markdown",
      content: "# a",
    });

    await patch(`/api/sessions/${sessionId}`, seed.token, { is_private: true });
    expect(
      await db.db.select().from(artifacts).where(eq(artifacts.sessionId, sessionId)),
    ).toHaveLength(0);
  });
});

describe("disable + purge cascade (REQ-037)", () => {
  it("POST /api/repos/disable with purge:true cascades all sessions/events/summaries/blobs for user+repo", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "purge@example.test",
      repoUrl: "github.com/example/purge",
    });
    const s1 = "purge-session-1";
    const s2 = "purge-session-2";
    await insertSession(s1, seed.user.id, seed.repoId);
    await insertSession(s2, seed.user.id, seed.repoId);
    await db.db.insert(events).values([
      {
        sessionId: s1,
        eventUuid: "p1-1",
        parentUuid: null,
        ts: new Date(),
        type: "user_msg",
        payload: {},
      },
      {
        sessionId: s2,
        eventUuid: "p2-1",
        parentUuid: null,
        ts: new Date(),
        type: "user_msg",
        payload: {},
      },
    ]);
    await db.db.insert(sessionBlobs).values([
      { sessionId: s1, jsonlBytes: Buffer.from("a"), byteSize: 1 },
      { sessionId: s2, jsonlBytes: Buffer.from("b"), byteSize: 1 },
    ]);

    const start = Date.now();
    const r = await app.request("/api/repos/disable", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${seed.token}`,
      },
      body: JSON.stringify({ canonical_url: seed.repoCanonical, purge: true }),
    });
    expect(r.status).toBe(200);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(60_000);

    const remaining = await db.db.select().from(sessions).where(eq(sessions.userId, seed.user.id));
    expect(remaining).toHaveLength(0);
    // Cascade also removed events + blobs.
    expect(await db.db.select().from(events).where(eq(events.sessionId, s1))).toHaveLength(0);
    expect(await db.db.select().from(events).where(eq(events.sessionId, s2))).toHaveLength(0);
    expect(
      await db.db.select().from(sessionBlobs).where(eq(sessionBlobs.sessionId, s1)),
    ).toHaveLength(0);
  });
});

describe("global reads + attribution (GitHub OAuth)", () => {
  it("GET /api/sessions returns OTHER users' sessions, with author + private hidden", async () => {
    const alice = await seedUser(db.db, env.JWT_SECRET, {
      githubLogin: "alice",
      repoUrl: "github.com/example/shared",
    });
    const bob = await seedUser(db.db, env.JWT_SECRET, {
      githubLogin: "bob",
      repoUrl: "github.com/example/shared",
    });
    await insertSession("sess-alice", alice.user.id, alice.repoId);
    await insertSession("sess-bob", bob.user.id, bob.repoId);
    // A private session owned by bob must be hidden from everyone.
    await db.db.update(sessions).set({ isPrivate: true }).where(eq(sessions.id, "sess-bob"));
    await insertSession("sess-bob-public", bob.user.id, bob.repoId);

    // Alice sees bob's public session (global reads), tagged with the author.
    const res = await get("/api/sessions?limit=50", alice.token);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      sessions: Array<{ id: string; author: { github_login: string } | null }>;
    };
    const ids = json.sessions.map((s) => s.id);
    expect(ids).toContain("sess-alice");
    expect(ids).toContain("sess-bob-public");
    expect(ids).not.toContain("sess-bob"); // private hidden
    const bobPublic = json.sessions.find((s) => s.id === "sess-bob-public");
    expect(bobPublic?.author?.github_login).toBe("bob");
  });

  it("GET /api/sessions with repeated ?user= ORs the authors (multi-select)", async () => {
    const alice = await seedUser(db.db, env.JWT_SECRET, {
      githubLogin: "feed-alice",
      repoUrl: "github.com/example/feed",
    });
    const bob = await seedUser(db.db, env.JWT_SECRET, {
      githubLogin: "feed-bob",
      repoUrl: "github.com/example/feed",
    });
    const carol = await seedUser(db.db, env.JWT_SECRET, {
      githubLogin: "feed-carol",
      repoUrl: "github.com/example/feed",
    });
    await insertSession("feed-a", alice.user.id, alice.repoId);
    await insertSession("feed-b", bob.user.id, bob.repoId);
    await insertSession("feed-c", carol.user.id, carol.repoId);

    const res = await get("/api/sessions?user=feed-alice&user=feed-bob&limit=50", carol.token);
    const json = (await res.json()) as { sessions: Array<{ id: string }> };
    expect(json.sessions.map((s) => s.id).sort()).toEqual(["feed-a", "feed-b"]);
  });

  it("GET /api/sessions with repeated ?repo= ORs the repos (multi-select)", async () => {
    const alice = await seedUser(db.db, env.JWT_SECRET, {
      githubLogin: "feed-repo-a",
      repoUrl: "github.com/example/feed-r1",
    });
    const bob = await seedUser(db.db, env.JWT_SECRET, {
      githubLogin: "feed-repo-b",
      repoUrl: "github.com/example/feed-r2",
    });
    const carol = await seedUser(db.db, env.JWT_SECRET, {
      githubLogin: "feed-repo-c",
      repoUrl: "github.com/example/feed-r3",
    });
    await insertSession("fr-a", alice.user.id, alice.repoId);
    await insertSession("fr-b", bob.user.id, bob.repoId);
    await insertSession("fr-c", carol.user.id, carol.repoId);

    const res = await get(
      `/api/sessions?repo=${encodeURIComponent(alice.repoCanonical)}&repo=${encodeURIComponent(bob.repoCanonical)}&limit=50`,
      carol.token,
    );
    const json = (await res.json()) as { sessions: Array<{ id: string }> };
    const ids = json.sessions.map((s) => s.id);
    expect(ids).toContain("fr-a");
    expect(ids).toContain("fr-b");
    expect(ids).not.toContain("fr-c");
  });

  it("GET /api/sessions?user=<login> narrows to one author", async () => {
    const alice = await seedUser(db.db, env.JWT_SECRET, {
      githubLogin: "alice2",
      repoUrl: "github.com/example/shared2",
    });
    const bob = await seedUser(db.db, env.JWT_SECRET, {
      githubLogin: "bob2",
      repoUrl: "github.com/example/shared2",
    });
    await insertSession("a2", alice.user.id, alice.repoId);
    await insertSession("b2", bob.user.id, bob.repoId);

    const res = await get("/api/sessions?user=bob2&limit=50", alice.token);
    const json = (await res.json()) as { sessions: Array<{ id: string }> };
    const ids = json.sessions.map((s) => s.id);
    expect(ids).toEqual(["b2"]);
  });

  it("a private session's blob and children are hidden from everyone (404 / empty)", async () => {
    const owner = await seedUser(db.db, env.JWT_SECRET, { githubLogin: "priv-owner" });
    const other = await seedUser(db.db, env.JWT_SECRET, { githubLogin: "priv-other" });
    await insertSession("priv-parent", owner.user.id, owner.repoId);
    await put("/api/sessions/priv-parent/blob", owner.token, new TextEncoder().encode("secret\n"));
    // A private child of a public parent must not surface in the children list.
    await insertSession("priv-child", owner.user.id, owner.repoId);
    await db.db
      .update(sessions)
      .set({ parentSessionId: "priv-parent", isPrivate: true })
      .where(eq(sessions.id, "priv-child"));

    // Children list (parent is public) excludes the private child.
    const childrenRes = await get("/api/sessions/priv-parent/children", other.token);
    expect(childrenRes.status).toBe(200);
    const childrenJson = (await childrenRes.json()) as { children: Array<{ id: string }> };
    expect(childrenJson.children.map((ch) => ch.id)).not.toContain("priv-child");

    // Now mark the parent private — its blob and children endpoints 404 for all.
    await db.db.update(sessions).set({ isPrivate: true }).where(eq(sessions.id, "priv-parent"));
    expect((await get("/api/sessions/priv-parent/blob", other.token)).status).toBe(404);
    expect((await get("/api/sessions/priv-parent/children", other.token)).status).toBe(404);
  });

  it("a non-owner can open another user's session detail", async () => {
    const alice = await seedUser(db.db, env.JWT_SECRET, { githubLogin: "alice3" });
    const bob = await seedUser(db.db, env.JWT_SECRET, { githubLogin: "bob3" });
    await insertSession("detail-bob", bob.user.id, bob.repoId);
    const res = await get("/api/sessions/detail-bob", alice.token);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { id: string; author: { github_login: string } | null };
    expect(json.id).toBe("detail-bob");
    expect(json.author?.github_login).toBe("bob3");
  });

  it("a non-owner CANNOT mutate another user's session (PATCH stays owner-only)", async () => {
    const alice = await seedUser(db.db, env.JWT_SECRET, { githubLogin: "alice4" });
    const bob = await seedUser(db.db, env.JWT_SECRET, { githubLogin: "bob4" });
    await insertSession("mut-bob", bob.user.id, bob.repoId);
    const res = await app.request("/api/sessions/mut-bob", {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ name: "hijacked" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("GET /api/repos/facets (repo-scoped filters, ?repo= query)", () => {
  const insertOn = async (
    id: string,
    userId: string,
    repoId: string,
    branch: string,
    isPrivate = false,
  ): Promise<void> => {
    await db.db.insert(sessions).values({
      id,
      userId,
      repoId,
      agent: "claude-code",
      agentVersion: "1.0.0",
      branch,
      sourceCwdHint: "/tmp/work",
      model: "claude-3-5-sonnet",
      permissionMode: "default",
      startedAt: new Date("2026-05-01T10:00:00.000Z"),
      endedAt: new Date("2026-05-01T10:30:00.000Z"),
      totalInputTokens: 100,
      totalOutputTokens: 50,
      totalCostUsd: "0.01",
      isPrivate,
    });
  };

  it("users facet lists ONLY members who pushed ≥1 session in this repo", async () => {
    const alice = await seedUser(db.db, env.JWT_SECRET, {
      githubLogin: "facet-alice",
      repoUrl: "github.com/example/facets",
    });
    const bob = await seedUser(db.db, env.JWT_SECRET, {
      githubLogin: "facet-bob",
      repoUrl: "github.com/example/facets",
    });
    // Carol exists and has a session, but only in a DIFFERENT repo.
    const carol = await seedUser(db.db, env.JWT_SECRET, {
      githubLogin: "facet-carol",
      repoUrl: "github.com/example/other",
    });
    await insertOn("f-alice", alice.user.id, alice.repoId, "main");
    await insertOn("f-bob", bob.user.id, bob.repoId, "feat/x");
    await insertOn("f-carol", carol.user.id, carol.repoId, "main");

    const res = await get(
      `/api/repos/facets?repo=${encodeURIComponent(alice.repoCanonical)}`,
      alice.token,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      branches: string[];
      users: Array<{ github_login: string; count: number }>;
    };
    const logins = json.users.map((u) => u.github_login).sort();
    expect(logins).toEqual(["facet-alice", "facet-bob"]);
    expect(logins).not.toContain("facet-carol");
    expect(json.branches.sort()).toEqual(["feat/x", "main"]);
  });

  it("excludes authors whose only session in this repo is private", async () => {
    const alice = await seedUser(db.db, env.JWT_SECRET, {
      githubLogin: "facet-pub",
      repoUrl: "github.com/example/facets-priv",
    });
    const bob = await seedUser(db.db, env.JWT_SECRET, {
      githubLogin: "facet-priv",
      repoUrl: "github.com/example/facets-priv",
    });
    await insertOn("fp-alice", alice.user.id, alice.repoId, "main");
    await insertOn("fp-bob", bob.user.id, bob.repoId, "secret", true);

    const res = await get(
      `/api/repos/facets?repo=${encodeURIComponent(alice.repoCanonical)}`,
      alice.token,
    );
    const json = (await res.json()) as {
      branches: string[];
      users: Array<{ github_login: string }>;
    };
    expect(json.users.map((u) => u.github_login)).toEqual(["facet-pub"]);
    expect(json.branches).not.toContain("secret");
  });

  it("GET /sessions?repo=<r>&branch=<b> narrows to that branch", async () => {
    const alice = await seedUser(db.db, env.JWT_SECRET, {
      githubLogin: "branch-alice",
      repoUrl: "github.com/example/branchfilter",
    });
    await insertOn("bf-main", alice.user.id, alice.repoId, "main");
    await insertOn("bf-feat", alice.user.id, alice.repoId, "feat/y");

    const res = await get(
      `/api/repos/sessions?repo=${encodeURIComponent(alice.repoCanonical)}&branch=feat/y`,
      alice.token,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { sessions: Array<{ id: string }> };
    expect(json.sessions.map((s) => s.id)).toEqual(["bf-feat"]);
  });

  it("repeated ?branch= params OR together (multi-select)", async () => {
    const alice = await seedUser(db.db, env.JWT_SECRET, {
      githubLogin: "multi-branch",
      repoUrl: "github.com/example/multibranch",
    });
    await insertOn("mb-main", alice.user.id, alice.repoId, "main");
    await insertOn("mb-demo", alice.user.id, alice.repoId, "demo");
    await insertOn("mb-feat", alice.user.id, alice.repoId, "feat/z");

    const res = await get(
      `/api/repos/sessions?repo=${encodeURIComponent(alice.repoCanonical)}&branch=main&branch=demo`,
      alice.token,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { sessions: Array<{ id: string }> };
    expect(json.sessions.map((s) => s.id).sort()).toEqual(["mb-demo", "mb-main"]);
  });

  it("repeated ?user= params OR together (multi-select)", async () => {
    const alice = await seedUser(db.db, env.JWT_SECRET, {
      githubLogin: "multi-u-alice",
      repoUrl: "github.com/example/multiuser",
    });
    const bob = await seedUser(db.db, env.JWT_SECRET, {
      githubLogin: "multi-u-bob",
      repoUrl: "github.com/example/multiuser",
    });
    const carol = await seedUser(db.db, env.JWT_SECRET, {
      githubLogin: "multi-u-carol",
      repoUrl: "github.com/example/multiuser",
    });
    await insertOn("mu-alice", alice.user.id, alice.repoId, "main");
    await insertOn("mu-bob", bob.user.id, bob.repoId, "main");
    await insertOn("mu-carol", carol.user.id, carol.repoId, "main");

    const res = await get(
      `/api/repos/sessions?repo=${encodeURIComponent(alice.repoCanonical)}&user=multi-u-alice&user=multi-u-bob`,
      alice.token,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { sessions: Array<{ id: string }> };
    expect(json.sessions.map((s) => s.id).sort()).toEqual(["mu-alice", "mu-bob"]);
  });

  it("GET /sessions with no ?repo= is a 400", async () => {
    const alice = await seedUser(db.db, env.JWT_SECRET, {
      githubLogin: "no-repo-sess",
      repoUrl: "github.com/example/norepo-sess",
    });
    const res = await get("/api/repos/sessions", alice.token);
    expect(res.status).toBe(400);
  });

  it("GET /facets with no ?repo= is a 400", async () => {
    const alice = await seedUser(db.db, env.JWT_SECRET, {
      githubLogin: "no-repo-facet",
      repoUrl: "github.com/example/norepo-facet",
    });
    const res = await get("/api/repos/facets", alice.token);
    expect(res.status).toBe(400);
  });
});

describe("GET /api/sessions/:id/event-count", () => {
  const insertEvents = async (sessionId: string, count: number): Promise<void> => {
    await db.db.insert(events).values(
      Array.from({ length: count }, (_, i) => ({
        sessionId,
        eventUuid: `${sessionId}-ev-${i}`,
        parentUuid: null,
        ts: new Date(`2026-05-01T10:0${i}:00.000Z`),
        type: "user_msg",
        payload: { content_md: `event ${i}` },
      })),
    );
  };

  it("returns the exact stored event count", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      githubLogin: "count-alice",
      repoUrl: "github.com/example/count",
    });
    const sessionId = "count-session-1";
    await insertSession(sessionId, seed.user.id, seed.repoId);
    await insertEvents(sessionId, 3);

    const res = await get(`/api/sessions/${sessionId}/event-count`, seed.token);
    expect(res.status).toBe(200);
    expect((await res.json()) as { count: number }).toEqual({ count: 3 });
  });

  it("404s for an unknown session", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      githubLogin: "count-bob",
      repoUrl: "github.com/example/count2",
    });
    const res = await get("/api/sessions/does-not-exist/event-count", seed.token);
    expect(res.status).toBe(404);
  });

  it("masks a private session's count as 0", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      githubLogin: "count-carol",
      repoUrl: "github.com/example/count3",
    });
    const sessionId = "count-session-private";
    await insertSession(sessionId, seed.user.id, seed.repoId);
    await insertEvents(sessionId, 5);
    await db.db.update(sessions).set({ isPrivate: true }).where(eq(sessions.id, sessionId));

    const res = await get(`/api/sessions/${sessionId}/event-count`, seed.token);
    expect(res.status).toBe(200);
    expect((await res.json()) as { count: number }).toEqual({ count: 0 });
  });
});
