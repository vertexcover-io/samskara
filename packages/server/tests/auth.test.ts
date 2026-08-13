// AI-generated. See PROMPT.md for the prompts and model used.

import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { GithubClient, GithubProfile } from "../src/auth/github.js";
import type { Db } from "../src/db/client.js";
import { users } from "../src/db/schema.js";
import type { Env } from "../src/env.js";
import { type TestPgHandle, startTestPostgres, truncateAll } from "./helpers/pg-test-container.js";
import { seedUser } from "./helpers/seed.js";

const OCTOCAT: GithubProfile = {
  id: 4242,
  login: "octocat",
  avatarUrl: "https://avatars.test/octocat",
  email: "octo@example.test",
};

const stubGithub = (opts: {
  member: boolean;
  profile?: GithubProfile;
  verifiedEmails?: string[];
}): GithubClient => {
  const profile = opts.profile ?? OCTOCAT;
  // Default: the profile email is verified. Pass verifiedEmails: [] to simulate
  // an unverified address.
  const verified = opts.verifiedEmails ?? (profile.email ? [profile.email] : []);
  return {
    exchangeCode: async () => ({ accessToken: "stub-token" }),
    getProfile: async () => profile,
    getPrimaryEmail: async () => profile.email,
    getVerifiedEmails: async () => verified,
    isOrgMember: async () => opts.member,
  };
};

// Drive /github/start, returning the raw oauth_state cookie value so the
// callback test can replay it as both the query param and the cookie.
const startOauth = async (testApp: Hono, from?: string): Promise<string> => {
  const path = from
    ? `/api/auth/github/start?from=${encodeURIComponent(from)}`
    : "/api/auth/github/start";
  const res = await testApp.request(path);
  expect(res.status).toBe(302);
  expect(res.headers.get("location") ?? "").toContain("github.com/login/oauth/authorize");
  const setCookie = res.headers.get("set-cookie") ?? "";
  const m = setCookie.match(/oauth_state=([^;]+)/);
  if (!m?.[1]) throw new Error("no oauth_state cookie");
  return m[1];
};

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

describe("GET /health", () => {
  it("returns ok without auth", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ status: "ok" });
  });
});

describe("GitHub OAuth login", () => {
  const oauthEnv = (): Env => ({
    ...env,
    GITHUB_CLIENT_ID: "test-client-id",
    GITHUB_CLIENT_SECRET: "test-client-secret",
  });

  it("GET /github/start redirects to GitHub and sets the state cookie", async () => {
    const a = buildApp(db.db, oauthEnv(), { githubClient: stubGithub({ member: true }) });
    const res = await a.request("/api/auth/github/start");
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") ?? "";
    expect(loc).toContain("https://github.com/login/oauth/authorize");
    expect(loc).toContain("scope=read%3Aorg+user%3Aemail");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/oauth_state=/);
    expect(setCookie.toLowerCase()).toContain("httponly");
  });

  it("callback creates a user + session cookie for an org member", async () => {
    const a = buildApp(db.db, oauthEnv(), { githubClient: stubGithub({ member: true }) });
    const state = await startOauth(a);
    const res = await a.request(`/api/auth/github/callback?code=abc&state=${state}`, {
      headers: { cookie: `oauth_state=${state}` },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    expect((res.headers.get("set-cookie") ?? "").toLowerCase()).toContain("session=");

    const rows = await db.db.select().from(users).where(eq(users.githubId, OCTOCAT.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.githubLogin).toBe("octocat");
    expect(rows[0]?.avatarUrl).toBe(OCTOCAT.avatarUrl);
  });

  it("callback rejects a non-org-member with no user row and no session", async () => {
    const a = buildApp(db.db, oauthEnv(), { githubClient: stubGithub({ member: false }) });
    const state = await startOauth(a);
    const res = await a.request(`/api/auth/github/callback?code=abc&state=${state}`, {
      headers: { cookie: `oauth_state=${state}` },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login?error=not_member");
    expect((res.headers.get("set-cookie") ?? "").toLowerCase()).not.toContain("session=");
    const rows = await db.db.select().from(users).where(eq(users.githubId, OCTOCAT.id));
    expect(rows).toHaveLength(0);
  });

  it("callback rejects a state mismatch (CSRF guard)", async () => {
    const a = buildApp(db.db, oauthEnv(), { githubClient: stubGithub({ member: true }) });
    const state = await startOauth(a);
    const res = await a.request(`/api/auth/github/callback?code=abc&state=${state}`, {
      headers: { cookie: "oauth_state=different-value" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login?error=state");
  });

  it("a second login with the same github_id updates rather than duplicates", async () => {
    const a = buildApp(db.db, oauthEnv(), {
      githubClient: stubGithub({ member: true, profile: { ...OCTOCAT, login: "octocat-renamed" } }),
    });
    // First login.
    let state = await startOauth(a);
    await a.request(`/api/auth/github/callback?code=abc&state=${state}`, {
      headers: { cookie: `oauth_state=${state}` },
    });
    // Second login (same id, new login handle).
    state = await startOauth(a);
    await a.request(`/api/auth/github/callback?code=abc&state=${state}`, {
      headers: { cookie: `oauth_state=${state}` },
    });
    const rows = await db.db.select().from(users).where(eq(users.githubId, OCTOCAT.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.githubLogin).toBe("octocat-renamed");
  });

  it("adopts an existing user row by email, preserving its id", async () => {
    // Pre-existing (e.g. legacy) row with the same email but no github identity.
    const existing = await db.db
      .insert(users)
      .values({ email: OCTOCAT.email, role: "user" })
      .returning({ id: users.id });
    const existingId = existing[0]?.id;

    const a = buildApp(db.db, oauthEnv(), { githubClient: stubGithub({ member: true }) });
    const state = await startOauth(a);
    await a.request(`/api/auth/github/callback?code=abc&state=${state}`, {
      headers: { cookie: `oauth_state=${state}` },
    });

    const rows = await db.db
      .select()
      .from(users)
      .where(eq(users.email, OCTOCAT.email ?? ""));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(existingId);
    expect(rows[0]?.githubId).toBe(OCTOCAT.id);
    expect(rows[0]?.githubLogin).toBe("octocat");
  });

  it("does NOT adopt a legacy row by an email the user has not GitHub-verified", async () => {
    const existing = await db.db
      .insert(users)
      .values({ email: OCTOCAT.email, role: "user" })
      .returning({ id: users.id });
    const existingId = existing[0]?.id;

    // getProfile reports the legacy email, but it is NOT among the verified
    // emails — adoption must refuse it. The login then fails safely on the
    // unique email rather than silently taking over the legacy row.
    const a = buildApp(db.db, oauthEnv(), {
      githubClient: stubGithub({ member: true, verifiedEmails: [] }),
    });
    const state = await startOauth(a);
    const res = await a.request(`/api/auth/github/callback?code=abc&state=${state}`, {
      headers: { cookie: `oauth_state=${state}` },
    });

    // Legacy row is NOT adopted (github identity stays empty) — no takeover.
    const legacy = await db.db
      .select()
      .from(users)
      .where(eq(users.id, existingId ?? ""));
    expect(legacy[0]?.githubId).toBeNull();
    expect(legacy[0]?.githubLogin).toBeNull();
    expect(res.headers.get("location")).toBe("/login?error=oauth");
  });

  it("does NOT re-link (hijack) a row that already has a github_id", async () => {
    // A victim already linked to github_id 111, sharing an email with the caller.
    const victim = await db.db
      .insert(users)
      .values({ email: "shared@example.test", githubId: 111, githubLogin: "victim", role: "user" })
      .returning({ id: users.id });
    const victimId = victim[0]?.id;

    // A different github id presents the same verified email.
    const other: GithubProfile = {
      id: 222,
      login: "other",
      avatarUrl: "https://avatars.test/other",
      email: "shared@example.test",
    };
    const a = buildApp(db.db, oauthEnv(), {
      githubClient: stubGithub({ member: true, profile: other }),
    });
    const state = await startOauth(a);
    await a.request(`/api/auth/github/callback?code=abc&state=${state}`, {
      headers: { cookie: `oauth_state=${state}` },
    });

    // Victim row keeps its github_id/login — the email match did NOT re-link it.
    const victimRow = await db.db
      .select()
      .from(users)
      .where(eq(users.id, victimId ?? ""));
    expect(victimRow[0]?.githubId).toBe(111);
    expect(victimRow[0]?.githubLogin).toBe("victim");
  });

  it("sanitizes the post-login redirect (open-redirect guard)", async () => {
    const a = buildApp(db.db, oauthEnv(), { githubClient: stubGithub({ member: true }) });
    for (const evil of ["//evil.com", "/\\evil.com", "https://evil.com"]) {
      const state = await startOauth(a, evil);
      const res = await a.request(`/api/auth/github/callback?code=abc&state=${state}`, {
        headers: { cookie: `oauth_state=${state}` },
      });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/");
    }
    // A genuine same-origin path is preserved.
    const okState = await startOauth(a, "/repos/github.com/acme/widget");
    const okRes = await a.request(`/api/auth/github/callback?code=abc&state=${okState}`, {
      headers: { cookie: `oauth_state=${okState}` },
    });
    expect(okRes.headers.get("location")).toBe("/repos/github.com/acme/widget");
  });
});

describe("auth-required routes (REQ-032)", () => {
  it("rejects /api/auth/me without token", async () => {
    const res = await app.request("/api/auth/me");
    expect(res.status).toBe(401);
  });

  it("rejects /api/ingest without token", async () => {
    const res = await app.request("/api/ingest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });

  it("rejects /api/repos/enable without token", async () => {
    const res = await app.request("/api/repos/enable", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });

  it("returns user from /api/auth/me with valid bearer", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET);
    const res = await app.request("/api/auth/me", {
      headers: { authorization: `Bearer ${seed.token}` },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { user: { id: string; email: string } };
    expect(json.user.id).toBe(seed.user.id);
    expect(json.user.email).toBe(seed.user.email);
  });
});

describe("POST /api/auth/logout", () => {
  it("clears the session cookie", async () => {
    const res = await app.request("/api/auth/logout", { method: "POST" });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie.toLowerCase()).toContain("session=");
  });
});

describe("POST /api/auth/cli-code + /api/auth/cli-exchange", () => {
  it("issues a code that exchanges for a cli-scoped bearer token", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, { email: "pair@example.test" });
    const codeRes = await app.request("/api/auth/cli-code", {
      method: "POST",
      headers: { authorization: `Bearer ${seed.token}` },
    });
    expect(codeRes.status).toBe(200);
    const codeJson = (await codeRes.json()) as { code: string };
    expect(codeJson.code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

    const exchangeRes = await app.request("/api/auth/cli-exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: codeJson.code }),
    });
    expect(exchangeRes.status).toBe(200);
    const exchangeJson = (await exchangeRes.json()) as {
      token: string;
      user: { id: string; email: string };
    };
    expect(exchangeJson.user.email).toBe("pair@example.test");
    const { verifyToken } = await import("../src/auth/jwt.js");
    const payload = await verifyToken(exchangeJson.token, env.JWT_SECRET);
    expect(payload.aud).toBe("cli");
    expect(payload.sub).toBe(seed.user.id);
  });

  it("rejects unknown codes", async () => {
    const res = await app.request("/api/auth/cli-exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "AAAA-BBBB" }),
    });
    expect(res.status).toBe(401);
  });

  it("a code is single-use", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, { email: "single@example.test" });
    const codeRes = await app.request("/api/auth/cli-code", {
      method: "POST",
      headers: { authorization: `Bearer ${seed.token}` },
    });
    const { code } = (await codeRes.json()) as { code: string };
    const first = await app.request("/api/auth/cli-exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    expect(first.status).toBe(200);
    const second = await app.request("/api/auth/cli-exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    expect(second.status).toBe(401);
  });

  it("requires auth to mint a code", async () => {
    const res = await app.request("/api/auth/cli-code", { method: "POST" });
    expect(res.status).toBe(401);
  });
});

describe("POST /api/auth/mcp-token (REQ-047)", () => {
  it("returns a fresh JWT with audience=mcp scoped to the user", async () => {
    const seed = await seedUser(db.db, env.JWT_SECRET, { email: "mcp-token@example.test" });
    const res = await app.request("/api/auth/mcp-token", {
      method: "POST",
      headers: { authorization: `Bearer ${seed.token}` },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { token: string };
    expect(json.token).toBeTypeOf("string");
    // verify the token round-trips with aud=mcp
    const { verifyToken } = await import("../src/auth/jwt.js");
    const payload = await verifyToken(json.token, env.JWT_SECRET);
    expect(payload.aud).toBe("mcp");
    expect(payload.sub).toBe(seed.user.id);
  });

  it("rejects without auth", async () => {
    const res = await app.request("/api/auth/mcp-token", { method: "POST" });
    expect(res.status).toBe(401);
  });
});
