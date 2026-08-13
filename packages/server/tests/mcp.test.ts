// AI-generated. See PROMPT.md for the prompts and model used.

import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { signToken } from "../src/auth/jwt.js";
import type { Db } from "../src/db/client.js";
import { embeddings, sessions, summaries } from "../src/db/schema.js";
import { getEmbedProvider, resetEmbedProvider } from "../src/embed/index.js";
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
  GITHUB_ALLOWED_LOGINS: "",
};

let pg: TestPgHandle;
let db: Db;
let env: Env;
let httpServer: ReturnType<typeof serve>;
let baseUrl: string;

const seedSession = async (
  sessionId: string,
  userId: string,
  repoId: string,
  title: string,
  summary: string,
  tags: string[] = [],
  prsReferenced: string[] = [],
): Promise<void> => {
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
  await db.db.insert(summaries).values({
    sessionId,
    title,
    summary,
    tags,
    filesTouched: [],
    prsReferenced,
    toolCallCounts: {},
    generatedAt: new Date(),
    model: "sonnet",
    status: "ok",
  });
  const provider = getEmbedProvider();
  const v = await provider.embed(`${title} ${summary} ${tags.join(" ")}`);
  await db.db.insert(embeddings).values({
    sessionId,
    embedding: v,
    embeddingModel: provider.name,
    version: 1,
  });
};

beforeAll(async () => {
  process.env.EMBED_PROVIDER = "fake";
  resetEmbedProvider();
  pg = await startTestPostgres();
  db = pg.db;
  env = { ...TEST_ENV, DATABASE_URL: pg.url };
  const app = buildApp(db.db, env);
  httpServer = await new Promise((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0 }, () => resolve(s));
  });
  const addr = httpServer.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
}, 180_000);

afterAll(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await pg.stop();
  resetEmbedProvider();
});

beforeEach(async () => {
  await truncateAll(db);
});

const buildClient = async (mcpToken: string): Promise<Client> => {
  const url = new URL(`${baseUrl}/mcp/${mcpToken}`);
  const transport = new StreamableHTTPClientTransport(url);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(transport);
  return client;
};

describe("MCP server (REQ-029)", () => {
  it("tools/list returns exactly the 6 expected tool names", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "mcp-list@example.test",
      repoUrl: "github.com/example/mcp-list",
    });
    const mcpToken = await signToken(
      { sub: seed.user.id, email: seed.user.email, role: "user", aud: "mcp" },
      env.JWT_SECRET,
    );
    const client = await buildClient(mcpToken);
    try {
      const list = await client.listTools();
      const names = list.tools.map((t) => t.name).sort();
      expect(names).toEqual(
        [
          "find_sessions_for_pr",
          "get_my_recent_sessions",
          "get_session",
          "mark_current_session_private",
          "mark_current_session_public",
          "search_sessions",
        ].sort(),
      );
    } finally {
      await client.close();
    }
  });

  it("invalid token rejects the connection", async () => {
    const url = new URL(`${baseUrl}/mcp/not-a-real-jwt`);
    const transport = new StreamableHTTPClientTransport(url);
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await expect(client.connect(transport)).rejects.toThrow();
  });

  it("search_sessions returns ranked results", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "mcp-search@example.test",
      repoUrl: "github.com/example/mcp-search",
    });
    await seedSession(
      "mcp-s-1",
      seed.user.id,
      seed.repoId,
      "MCP wiring for hybrid search",
      "Wired the MCP server to share the search-internal helper with the HTTP route.",
      ["mcp", "search"],
    );

    const mcpToken = await signToken(
      { sub: seed.user.id, email: seed.user.email, role: "user", aud: "mcp" },
      env.JWT_SECRET,
    );
    const client = await buildClient(mcpToken);
    try {
      const out = await client.callTool({
        name: "search_sessions",
        arguments: { query: "MCP wiring hybrid", limit: 5 },
      });
      const content = out.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0]!.text) as {
        results: Array<{ session_id: string }>;
        strategy: string;
      };
      expect(parsed.strategy).toBe("rrf");
      expect(parsed.results[0]?.session_id).toBe("mcp-s-1");
    } finally {
      await client.close();
    }
  });

  it("get_session returns the session detail JSON shape", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "mcp-get@example.test",
      repoUrl: "github.com/example/mcp-get",
    });
    await seedSession(
      "mcp-get-1",
      seed.user.id,
      seed.repoId,
      "Get session details",
      "Detail summary used by get_session.",
      ["detail"],
    );
    const mcpToken = await signToken(
      { sub: seed.user.id, email: seed.user.email, role: "user", aud: "mcp" },
      env.JWT_SECRET,
    );
    const client = await buildClient(mcpToken);
    try {
      const out = await client.callTool({
        name: "get_session",
        arguments: { session_id: "mcp-get-1" },
      });
      const content = out.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0]!.text) as { session_id: string; title: string };
      expect(parsed.session_id).toBe("mcp-get-1");
      expect(parsed.title).toBe("Get session details");
    } finally {
      await client.close();
    }
  });

  it("find_sessions_for_pr returns sessions referencing the PR", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "mcp-pr@example.test",
      repoUrl: "github.com/example/mcp-pr",
    });
    const PR = "https://github.com/example/mcp-pr/pull/42";
    await seedSession(
      "mcp-pr-hit",
      seed.user.id,
      seed.repoId,
      "PR-linked work",
      "Did the work that opened the PR.",
      [],
      [PR],
    );
    await seedSession("mcp-pr-other", seed.user.id, seed.repoId, "Other work", "Unrelated.");
    const mcpToken = await signToken(
      { sub: seed.user.id, email: seed.user.email, role: "user", aud: "mcp" },
      env.JWT_SECRET,
    );
    const client = await buildClient(mcpToken);
    try {
      const out = await client.callTool({
        name: "find_sessions_for_pr",
        arguments: { pr_url: PR },
      });
      const content = out.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0]!.text) as Array<{ session_id: string }>;
      expect(parsed.map((s) => s.session_id)).toEqual(["mcp-pr-hit"]);
    } finally {
      await client.close();
    }
  });

  it("get_my_recent_sessions lists user's sessions newest first", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "mcp-recent@example.test",
      repoUrl: "github.com/example/mcp-recent",
    });
    // seed two sessions with different startedAt
    await db.db.insert(sessions).values({
      id: "mcp-rec-old",
      userId: seed.user.id,
      repoId: seed.repoId,
      agent: "claude-code",
      agentVersion: "1.0.0",
      branch: "main",
      sourceCwdHint: "/tmp",
      startedAt: new Date("2026-04-01T10:00:00.000Z"),
      endedAt: new Date("2026-04-01T10:30:00.000Z"),
      totalCostUsd: "0",
    });
    await db.db.insert(sessions).values({
      id: "mcp-rec-new",
      userId: seed.user.id,
      repoId: seed.repoId,
      agent: "claude-code",
      agentVersion: "1.0.0",
      branch: "main",
      sourceCwdHint: "/tmp",
      startedAt: new Date("2026-05-01T10:00:00.000Z"),
      endedAt: new Date("2026-05-01T10:30:00.000Z"),
      totalCostUsd: "0",
    });
    const mcpToken = await signToken(
      { sub: seed.user.id, email: seed.user.email, role: "user", aud: "mcp" },
      env.JWT_SECRET,
    );
    const client = await buildClient(mcpToken);
    try {
      const out = await client.callTool({
        name: "get_my_recent_sessions",
        arguments: { limit: 5 },
      });
      const content = out.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0]!.text) as Array<{ session_id: string }>;
      expect(parsed[0]?.session_id).toBe("mcp-rec-new");
      expect(parsed[1]?.session_id).toBe("mcp-rec-old");
    } finally {
      await client.close();
    }
  });

  it("mark_current_session_private and _public flip is_private", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "mcp-priv@example.test",
      repoUrl: "github.com/example/mcp-priv",
    });
    await seedSession("mcp-priv-1", seed.user.id, seed.repoId, "Privacy test", "Toggle privacy.");
    const mcpToken = await signToken(
      { sub: seed.user.id, email: seed.user.email, role: "user", aud: "mcp" },
      env.JWT_SECRET,
    );
    const client = await buildClient(mcpToken);
    try {
      await client.callTool({
        name: "mark_current_session_private",
        arguments: { session_id: "mcp-priv-1" },
      });
      const after = await db.sql<{ is_private: boolean }[]>`
        SELECT is_private FROM sessions WHERE id = 'mcp-priv-1'`;
      expect(after[0]?.is_private).toBe(true);

      await client.callTool({
        name: "mark_current_session_public",
        arguments: { session_id: "mcp-priv-1" },
      });
      const back = await db.sql<{ is_private: boolean }[]>`
        SELECT is_private FROM sessions WHERE id = 'mcp-priv-1'`;
      expect(back[0]?.is_private).toBe(false);
    } finally {
      await client.close();
    }
  });
});
