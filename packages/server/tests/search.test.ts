// AI-generated. See PROMPT.md for the prompts and model used.

import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
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
let app: Hono;
let env: Env;

interface SeedSessionOpts {
  sessionId: string;
  userId: string;
  repoId: string;
  branch?: string;
  agent?: string;
  startedAt?: Date;
  title: string;
  summary: string;
  tags?: string[];
  prsReferenced?: string[];
}

const seedSessionWithSummary = async (opts: SeedSessionOpts): Promise<void> => {
  const startedAt = opts.startedAt ?? new Date("2026-05-01T10:00:00.000Z");
  const endedAt = new Date(startedAt.getTime() + 30 * 60 * 1000);
  await db.db.insert(sessions).values({
    id: opts.sessionId,
    userId: opts.userId,
    repoId: opts.repoId,
    agent: opts.agent ?? "claude-code",
    agentVersion: "1.0.0",
    branch: opts.branch ?? "main",
    sourceCwdHint: "/tmp/work",
    model: "claude-3-5-sonnet",
    permissionMode: "default",
    startedAt,
    endedAt,
    totalInputTokens: 100,
    totalOutputTokens: 50,
    totalCostUsd: "0.01",
  });

  await db.db.insert(summaries).values({
    sessionId: opts.sessionId,
    title: opts.title,
    summary: opts.summary,
    tags: opts.tags ?? [],
    filesTouched: [],
    prsReferenced: opts.prsReferenced ?? [],
    toolCallCounts: {},
    generatedAt: new Date(),
    model: "sonnet",
    status: "ok",
  });

  const provider = getEmbedProvider();
  const embedText = [opts.title, opts.summary, (opts.tags ?? []).join(" ")].join(" ");
  const vec = await provider.embed(embedText);
  await db.db.insert(embeddings).values({
    sessionId: opts.sessionId,
    embedding: vec,
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
  app = buildApp(db.db, env);
}, 180_000);

afterAll(async () => {
  await pg.stop();
  resetEmbedProvider();
});

beforeEach(async () => {
  await truncateAll(db);
});

const get = async (path: string, token: string): Promise<Response> =>
  app.request(path, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });

interface SearchResp {
  results: Array<{
    session_id: string;
    title: string | null;
    summary: string | null;
    tags: string[];
    repo: string | null;
    branch: string | null;
    agent: string;
    started_at: string;
    ended_at: string;
    total_cost_usd: string;
    author: { github_login: string; avatar_url: string | null } | null;
  }>;
  strategy: string;
}

describe("GET /api/search (REQ-022)", () => {
  it("returns ranked sessions with strategy=rrf for a known query", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "search-1@example.test",
      repoUrl: "github.com/example/search-1",
    });
    await seedSessionWithSummary({
      sessionId: "s-fts-hit",
      userId: seed.user.id,
      repoId: seed.repoId,
      title: "Add reciprocal rank fusion to hybrid search",
      summary:
        "Implemented hybrid search by combining FTS and pgvector cosine similarity using reciprocal rank fusion (RRF) with k=60.",
      tags: ["search", "rrf"],
    });
    await seedSessionWithSummary({
      sessionId: "s-irrelevant",
      userId: seed.user.id,
      repoId: seed.repoId,
      title: "Refactor the credentials loader",
      summary: "Moved the keychain helpers behind a small interface.",
      tags: ["refactor"],
    });

    const res = await get("/api/search?q=reciprocal+rank+fusion", seed.token);
    expect(res.status).toBe(200);
    const json = (await res.json()) as SearchResp;
    expect(json.strategy).toBe("rrf");
    expect(json.results.length).toBeGreaterThan(0);
    expect(json.results[0]?.session_id).toBe("s-fts-hit");
  });

  it("global reads: user A's query DOES return user B's sessions, with author", async () => {
    const a = await seedUser(db.db, env.JWT_SECRET, {
      githubLogin: "search-a",
      repoUrl: "github.com/example/search-a",
    });
    const b = await seedUser(db.db, env.JWT_SECRET, {
      githubLogin: "search-b",
      repoUrl: "github.com/example/search-b",
    });
    await seedSessionWithSummary({
      sessionId: "s-secret-of-b",
      userId: b.user.id,
      repoId: b.repoId,
      title: "Top-secret deployment runbook for kubernetes cluster",
      summary: "Bumped pod replicas and patched the ingress controller.",
      tags: ["deploy", "k8s"],
    });

    const res = await get("/api/search?q=top-secret+deployment", a.token);
    expect(res.status).toBe(200);
    const json = (await res.json()) as SearchResp;
    const hit = json.results.find((r) => r.session_id === "s-secret-of-b");
    expect(hit).toBeDefined();
    expect(hit?.author?.github_login).toBe("search-b");
  });

  it("filters by repo, branch, agent, has_pr, since", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "search-filter@example.test",
      repoUrl: "github.com/example/filter-a",
    });
    const otherRepo = await seedUser(db.db, env.JWT_SECRET, {
      email: "search-filter-2@example.test",
      repoUrl: "github.com/example/filter-b",
    });
    // Grant `seed` access to otherRepo so "no repo filter" returns both
    await db.sql`INSERT INTO user_repos(user_id, repo_id, access)
       VALUES (${seed.user.id}, ${otherRepo.repoId}, 'read')
       ON CONFLICT DO NOTHING`;

    await seedSessionWithSummary({
      sessionId: "s-fa-main-cc",
      userId: seed.user.id,
      repoId: seed.repoId,
      branch: "main",
      agent: "claude-code",
      startedAt: new Date("2026-04-01T10:00:00.000Z"),
      title: "Bandwidth tuning notes for the realtime engine",
      summary: "Tuned realtime engine bandwidth to keep p99 below 50ms with backpressure.",
      tags: ["bandwidth"],
      prsReferenced: ["https://github.com/example/x/pull/1"],
    });
    await seedSessionWithSummary({
      sessionId: "s-fa-feat",
      userId: seed.user.id,
      repoId: seed.repoId,
      branch: "feat",
      agent: "cursor",
      startedAt: new Date("2026-05-15T10:00:00.000Z"),
      title: "Bandwidth tuning notes for the worker pool",
      summary: "Bandwidth notes — split work into queues to bound tail latency.",
      tags: ["bandwidth"],
      prsReferenced: [],
    });
    await seedSessionWithSummary({
      sessionId: "s-fb",
      userId: seed.user.id,
      repoId: otherRepo.repoId,
      branch: "main",
      agent: "claude-code",
      startedAt: new Date("2026-04-15T10:00:00.000Z"),
      title: "Bandwidth tuning notes for the metrics pipeline",
      summary: "Bandwidth tweaks to the metrics aggregator.",
      tags: ["bandwidth", "metrics"],
      prsReferenced: [],
    });

    // No filter: should see all 3
    const all = (await (
      await get("/api/search?q=bandwidth+tuning", seed.token)
    ).json()) as SearchResp;
    const allIds = new Set(all.results.map((r) => r.session_id));
    expect(allIds.has("s-fa-main-cc")).toBe(true);
    expect(allIds.has("s-fa-feat")).toBe(true);
    expect(allIds.has("s-fb")).toBe(true);

    // Repo filter narrows
    const byRepo = (await (
      await get(
        `/api/search?q=bandwidth+tuning&repo=${encodeURIComponent("github.com/example/filter-a")}`,
        seed.token,
      )
    ).json()) as SearchResp;
    const byRepoIds = new Set(byRepo.results.map((r) => r.session_id));
    expect(byRepoIds.has("s-fb")).toBe(false);

    // Branch filter narrows
    const byBranch = (await (
      await get("/api/search?q=bandwidth+tuning&branch=feat", seed.token)
    ).json()) as SearchResp;
    expect(byBranch.results.every((r) => r.branch === "feat")).toBe(true);

    // Agent filter narrows
    const byAgent = (await (
      await get("/api/search?q=bandwidth+tuning&agent=cursor", seed.token)
    ).json()) as SearchResp;
    expect(byAgent.results.every((r) => r.agent === "cursor")).toBe(true);

    // has_pr filter
    const withPr = (await (
      await get("/api/search?q=bandwidth+tuning&has_pr=true", seed.token)
    ).json()) as SearchResp;
    expect(withPr.results.every((r) => r.session_id === "s-fa-main-cc")).toBe(true);

    // since filter
    const sinceRes = (await (
      await get(
        `/api/search?q=bandwidth+tuning&since=${encodeURIComponent("2026-05-01T00:00:00.000Z")}`,
        seed.token,
      )
    ).json()) as SearchResp;
    expect(sinceRes.results.every((r) => r.session_id === "s-fa-feat")).toBe(true);
  });

  it("performance smoke: 1000 fixture sessions, p95 < 500ms", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, {
      email: "search-perf@example.test",
      repoUrl: "github.com/example/perf-1",
    });

    const provider = getEmbedProvider();
    const N = 1000;
    const sessionRows: Array<typeof sessions.$inferInsert> = [];
    const summaryRows: Array<typeof summaries.$inferInsert> = [];
    const embeddingRows: Array<typeof embeddings.$inferInsert> = [];
    for (let i = 0; i < N; i++) {
      const id = `perf-${i}`;
      const started = new Date(2026, 0, 1, 10, 0, 0, 0);
      started.setUTCMinutes(started.getUTCMinutes() + i);
      sessionRows.push({
        id,
        userId: seed.user.id,
        repoId: seed.repoId,
        agent: "claude-code",
        agentVersion: "1.0.0",
        branch: "main",
        sourceCwdHint: "/tmp/work",
        model: "claude-3-5-sonnet",
        permissionMode: "default",
        startedAt: started,
        endedAt: new Date(started.getTime() + 60_000),
        totalInputTokens: 10,
        totalOutputTokens: 5,
        totalCostUsd: "0.001",
      });
      const title = `session ${i} about topic ${i % 17}`;
      const summary = `Worked on topic ${i % 17}; touched files ${i % 7}; observed metric ${i % 11}.`;
      summaryRows.push({
        sessionId: id,
        title,
        summary,
        tags: [`topic-${i % 17}`],
        filesTouched: [],
        prsReferenced: [],
        toolCallCounts: {},
        generatedAt: started,
        model: "sonnet",
        status: "ok",
      });
      const v = await provider.embed(`${title} ${summary}`);
      embeddingRows.push({
        sessionId: id,
        embedding: v,
        embeddingModel: provider.name,
        version: 1,
      });
    }

    // bulk insert in chunks
    const chunk = <T>(arr: T[], n: number): T[][] => {
      const out: T[][] = [];
      for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
      return out;
    };
    for (const batch of chunk(sessionRows, 100)) {
      await db.db.insert(sessions).values(batch);
    }
    for (const batch of chunk(summaryRows, 100)) {
      await db.db.insert(summaries).values(batch);
    }
    for (const batch of chunk(embeddingRows, 100)) {
      await db.db.insert(embeddings).values(batch);
    }

    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t0 = Date.now();
      const r = await get("/api/search?q=topic+5+about", seed.token);
      const ms = Date.now() - t0;
      expect(r.status).toBe(200);
      samples.push(ms);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95)] ?? 0;
    expect(p95).toBeLessThan(500);
  }, 120_000);
});
