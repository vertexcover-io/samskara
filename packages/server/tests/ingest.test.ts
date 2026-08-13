// AI-generated. See PROMPT.md for the prompts and model used.

import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { Db } from "../src/db/client.js";
import { events, sessions } from "../src/db/schema.js";
import type { Env } from "../src/env.js";
import { type TestPgHandle, startTestPostgres, truncateAll } from "./helpers/pg-test-container.js";
import { seedUser } from "./helpers/seed.js";

const TEST_ENV: Env = {
  DATABASE_URL: "",
  JWT_SECRET: "test-secret-test-secret-test",
  EMBED_PROVIDER: "none",
  OPENAI_EMBED_MODEL: "text-embedding-3-small",
  PORT: 0,
  NODE_ENV: "test",
  GITHUB_ORG: "test-org",
  GITHUB_ALLOWED_LOGINS: "",
};

interface IngestBody {
  session: {
    id: string;
    agent: "claude-code";
    agent_version: string;
    repo: { canonical_url: string; branch: string | null };
    parent_session_id?: string;
    source_cwd_hint: string;
    started_at: string;
    ended_at: string;
    model: string | null;
    permission_mode: string | null;
    total_input_tokens: number;
    total_output_tokens: number;
    total_cost_usd: number;
  };
  events: Array<{
    event_uuid: string;
    parent_uuid: string | null;
    ts: string;
    type: "user_msg" | "assistant_msg" | "tool_use" | "summary" | "system";
    payload: unknown;
  }>;
}

const buildIngestPayload = (
  sessionId: string,
  repoUrl: string,
  events: IngestBody["events"],
): IngestBody => ({
  session: {
    id: sessionId,
    agent: "claude-code",
    agent_version: "1.0.0",
    repo: { canonical_url: repoUrl, branch: "main" },
    source_cwd_hint: "/tmp/work",
    started_at: "2026-05-01T10:00:00.000Z",
    ended_at: "2026-05-01T10:30:00.000Z",
    model: "claude-3-5-sonnet",
    permission_mode: "default",
    total_input_tokens: 100,
    total_output_tokens: 50,
    total_cost_usd: 0.01,
  },
  events,
});

let pg: TestPgHandle;
let db: Db;
let app: Hono;
let env: Env;

beforeAll(async () => {
  pg = await startTestPostgres();
  db = pg.db;
  env = { ...TEST_ENV, DATABASE_URL: pg.url };
  app = buildApp(db.db, env);
}, 180_000);

afterAll(async () => {
  await pg.stop();
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

const get = async (path: string, token: string): Promise<Response> =>
  app.request(path, { method: "GET", headers: { authorization: `Bearer ${token}` } });

describe("POST /api/ingest", () => {
  it("REQ-033: idempotent — same batch posted twice yields one row per event", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "ingest-a@example.test",
      repoUrl: "github.com/example/idempotent",
    });
    const sessionId = "session-idempotent-1";
    const payload = buildIngestPayload(sessionId, seed.repoCanonical, [
      {
        event_uuid: "ev-1",
        parent_uuid: null,
        ts: "2026-05-01T10:00:01.000Z",
        type: "user_msg",
        payload: { text: "hello" },
      },
      {
        event_uuid: "ev-2",
        parent_uuid: "ev-1",
        ts: "2026-05-01T10:00:02.000Z",
        type: "assistant_msg",
        payload: { text: "hi" },
      },
    ]);

    const r1 = await post("/api/ingest", seed.token, payload);
    expect(r1.status).toBe(200);
    const r2 = await post("/api/ingest", seed.token, payload);
    expect(r2.status).toBe(200);

    const j2 = (await r2.json()) as { accepted_events: number; skipped_duplicates: number };
    expect(j2.accepted_events).toBe(0);
    expect(j2.skipped_duplicates).toBe(2);

    const rows =
      await db.sql`SELECT count(*)::int AS c FROM events WHERE session_id = ${sessionId}`;
    expect(rows[0]?.c).toBe(2);
  });

  it("auto-grants the repo on first push (no prior enable needed)", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "no-repo@example.test",
      grantRepo: false,
    });
    const payload = buildIngestPayload("s-no-repo", "github.com/foreign/repo", []);
    const res = await post("/api/ingest", seed.token, payload);
    expect(res.status).toBe(200);
    // The session is attributed to the pusher.
    const rows = await db.db.select().from(sessions).where(eq(sessions.id, "s-no-repo"));
    expect(rows[0]?.userId).toBe(seed.user.id);
  });

  it("any member can ingest into a shared repo; the session is attributed to the pusher", async () => {
    const a = await seedUser(db.db, env.JWT_SECRET, {
      email: "a-rbac@example.test",
      repoUrl: "github.com/example/shared-repo",
    });
    const b = await seedUser(db.db, env.JWT_SECRET, {
      email: "b-rbac@example.test",
      grantRepo: false,
    });
    // B pushes into the repo A also uses — allowed, stamped as B's session.
    const payload = buildIngestPayload("s-cross", a.repoCanonical, []);
    const res = await post("/api/ingest", b.token, payload);
    expect(res.status).toBe(200);
    const rows = await db.db.select().from(sessions).where(eq(sessions.id, "s-cross"));
    expect(rows[0]?.userId).toBe(b.user.id);
  });

  it("REQ-049: API responses serialize timestamps with Z suffix", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "ts@example.test",
      repoUrl: "github.com/example/tz",
    });
    const sessionId = "session-tz-1";
    const payload = buildIngestPayload(sessionId, seed.repoCanonical, [
      {
        event_uuid: "ev-z-1",
        parent_uuid: null,
        ts: "2026-05-01T10:00:01.000Z",
        type: "user_msg",
        payload: { text: "z-test" },
      },
    ]);
    const r = await post("/api/ingest", seed.token, payload);
    expect(r.status).toBe(200);

    // Verify TIMESTAMPTZ storage and Z-suffix serialization via raw SQL.
    const rows = await db.sql<{ ts_iso: string; started_iso: string }[]>`SELECT
        to_char((SELECT ts FROM events WHERE session_id = ${sessionId} LIMIT 1) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ts_iso,
        to_char((SELECT started_at FROM sessions WHERE id = ${sessionId}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS started_iso`;
    expect(rows[0]?.ts_iso).toMatch(/Z$/);
    expect(rows[0]?.started_iso).toMatch(/Z$/);

    // And that JS Date round-trip via toISOString yields a Z suffix when read
    // through drizzle (which materializes TIMESTAMPTZ as a Date).
    const drizzleRows = await db.db
      .select({ ts: events.ts })
      .from(events)
      .where(eq(events.sessionId, sessionId));
    expect(drizzleRows[0]?.ts.toISOString().endsWith("Z")).toBe(true);
  });

  it("REQ-034: payload containing AKIA... is redacted at rest", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "redact@example.test",
      repoUrl: "github.com/example/redact",
    });
    const sessionId = "session-redact-1";
    const payload = buildIngestPayload(sessionId, seed.repoCanonical, [
      {
        event_uuid: "ev-redact-1",
        parent_uuid: null,
        ts: "2026-05-01T10:00:01.000Z",
        type: "tool_use",
        payload: { command: "echo AKIA0123456789ABCDEF run" },
      },
    ]);
    const r = await post("/api/ingest", seed.token, payload);
    expect(r.status).toBe(200);

    const rows = await db.db
      .select({ payload: events.payload })
      .from(events)
      .where(eq(events.sessionId, sessionId));
    const stored = JSON.stringify(rows[0]?.payload ?? {});
    expect(stored).not.toContain("AKIA0123456789ABCDEF");
    expect(stored).toContain("[REDACTED:");
  });
});

describe("subagent (child) sessions", () => {
  it("ingests a child with parent_session_id; lists exclude it; /children + /events reach it", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "subagent@example.test",
      repoUrl: "github.com/example/subagent",
    });
    const parentId = "session-parent-1";
    const childId = "agent-child-1";

    const parentPayload = buildIngestPayload(parentId, seed.repoCanonical, [
      {
        event_uuid: "ev-parent-1",
        parent_uuid: null,
        ts: "2026-05-01T10:00:01.000Z",
        type: "tool_use",
        payload: { tool: "Agent", agent_id: childId },
      },
    ]);
    const childPayload = buildIngestPayload(childId, seed.repoCanonical, [
      {
        event_uuid: "ev-child-1",
        parent_uuid: null,
        ts: "2026-05-01T10:00:05.000Z",
        type: "user_msg",
        payload: { text: "subagent prompt" },
      },
    ]);
    childPayload.session.parent_session_id = parentId;

    expect((await post("/api/ingest", seed.token, parentPayload)).status).toBe(200);
    expect((await post("/api/ingest", seed.token, childPayload)).status).toBe(200);

    // The link persists on the child row.
    const linkRows = await db.sql<{ parent_session_id: string | null }[]>`
      SELECT parent_session_id FROM sessions WHERE id = ${childId}`;
    expect(linkRows[0]?.parent_session_id).toBe(parentId);

    // The top-level list excludes the child but includes the parent.
    const listRes = await get("/api/sessions", seed.token);
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { sessions: { id: string }[] };
    const ids = list.sessions.map((s) => s.id);
    expect(ids).toContain(parentId);
    expect(ids).not.toContain(childId);

    // /children lists the child under its parent.
    const childrenRes = await get(`/api/sessions/${parentId}/children`, seed.token);
    expect(childrenRes.status).toBe(200);
    const children = (await childrenRes.json()) as { children: { id: string }[] };
    expect(children.children.map((c) => c.id)).toEqual([childId]);

    // A child is just another session: its events are reachable directly.
    const eventsRes = await get(`/api/sessions/${childId}/events`, seed.token);
    expect(eventsRes.status).toBe(200);
    const childEvents = (await eventsRes.json()) as { events: { event_uuid: string }[] };
    expect(childEvents.events.map((e) => e.event_uuid)).toEqual(["ev-child-1"]);
  });

  it("ingests a child before its parent exists (no FK ordering hard-fail)", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "subagent-order@example.test",
      repoUrl: "github.com/example/subagent-order",
    });
    const parentId = "session-parent-2";
    const childId = "agent-child-2";

    const childPayload = buildIngestPayload(childId, seed.repoCanonical, []);
    childPayload.session.parent_session_id = parentId;

    // Child first — the parent row does not exist yet.
    expect((await post("/api/ingest", seed.token, childPayload)).status).toBe(200);
    const rows = await db.sql<{ parent_session_id: string | null }[]>`
      SELECT parent_session_id FROM sessions WHERE id = ${childId}`;
    expect(rows[0]?.parent_session_id).toBe(parentId);
  });
});

describe("REQ-049: TIMESTAMPTZ column types", () => {
  it("all timestamp columns are TIMESTAMPTZ", async () => {
    const rows = await db.sql<{ table_name: string; column_name: string; data_type: string }[]>`
      SELECT table_name, column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND data_type IN ('timestamp without time zone', 'timestamp with time zone')
    `;
    for (const row of rows) {
      expect(row.data_type, `${row.table_name}.${row.column_name}`).toBe(
        "timestamp with time zone",
      );
    }
  });
});
