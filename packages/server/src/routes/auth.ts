// AI-generated. See PROMPT.md for the prompts and model used.

import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { type GithubClient, createGithubClient } from "../auth/github.js";
import { signToken } from "../auth/jwt.js";
import { type AuthVariables, buildRequireAuth } from "../auth/middleware.js";
import type { DbClient } from "../db/client.js";
import { users } from "../db/schema.js";
import { upsertGithubUser } from "../db/users.js";
import type { Env } from "../env.js";

const exchangeSchema = z.object({
  code: z.string().min(8).max(32),
});

// GitHub may not expose an email; synthesize a stable non-null value so the
// JWT `email` claim (and every consumer of it) stays a plain string.
const emailForToken = (email: string | null, login: string): string =>
  email ?? `${login}@users.noreply.github.com`;

// Only allow same-origin relative paths as the post-login redirect target.
// Must start with "/" but not be protocol-relative: browsers normalize both
// "//host" and "/\host" (backslash) into an external origin, so reject when the
// second char is "/" or "\".
const safeReturnPath = (raw: string | undefined): string => {
  if (!raw || !raw.startsWith("/")) return "/";
  if (raw[1] === "/" || raw[1] === "\\") return "/";
  return raw;
};

interface PairEntry {
  userId: string;
  email: string;
  role: "user" | "admin";
  expiresAt: number;
}

const pairCodes = new Map<string, PairEntry>();
const PAIR_TTL_MS = 5 * 60 * 1000;

const sweepExpired = (now: number): void => {
  for (const [code, entry] of pairCodes) {
    if (entry.expiresAt <= now) pairCodes.delete(code);
  }
};

const generatePairCode = (): string => {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i += 1) {
    const b = bytes[i] ?? 0;
    out += alphabet[b % alphabet.length];
  }
  return `${out.slice(0, 4)}-${out.slice(4)}`;
};

export const buildAuthRouter = (
  db: DbClient,
  env: Env,
  githubClient: GithubClient = createGithubClient(env),
): Hono<{ Variables: AuthVariables }> => {
  const router = new Hono<{ Variables: AuthVariables }>();
  const requireAuth = buildRequireAuth(env);
  const cookieSecure = env.COOKIE_SECURE ?? env.NODE_ENV === "production";
  const allowedLogins = new Set(
    env.GITHUB_ALLOWED_LOGINS.split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );

  const redirectUri = (c: { req: { url: string } }): string => {
    const base = env.APP_BASE_URL ?? new URL(c.req.url).origin;
    return `${base.replace(/\/+$/, "")}/api/auth/github/callback`;
  };

  // GET /api/auth/github/start — kick off the OAuth web flow. We stash a random
  // `state` (plus the optional return path) in a short-lived httpOnly cookie and
  // verify it on callback (CSRF protection).
  router.get("/github/start", (c) => {
    if (!env.GITHUB_CLIENT_ID) {
      return c.json({ error: "github oauth not configured" }, 500);
    }
    const nonce = randomBytes(16).toString("hex");
    const from = safeReturnPath(c.req.query("from"));
    const state = `${nonce}.${Buffer.from(from).toString("base64url")}`;
    setCookie(c, "oauth_state", state, {
      httpOnly: true,
      secure: cookieSecure,
      sameSite: "Lax",
      path: "/",
      maxAge: 600,
    });
    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
    url.searchParams.set("redirect_uri", redirectUri(c));
    url.searchParams.set("scope", "read:org user:email");
    url.searchParams.set("state", state);
    return c.redirect(url.toString());
  });

  // GET /api/auth/github/callback — exchange the code, gate on org membership,
  // upsert the user, and set the web session cookie.
  router.get("/github/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    const cookieState = getCookie(c, "oauth_state");
    deleteCookie(c, "oauth_state", { path: "/" });

    if (!code || !state || !cookieState || state !== cookieState) {
      return c.redirect("/login?error=state");
    }
    const from = safeReturnPath(
      Buffer.from(state.split(".")[1] ?? "", "base64url").toString("utf8"),
    );

    try {
      const { accessToken } = await githubClient.exchangeCode(code, redirectUri(c));
      const profile = await githubClient.getProfile(accessToken);
      if (!allowedLogins.has(profile.login.toLowerCase())) {
        const isMember = await githubClient.isOrgMember(accessToken, env.GITHUB_ORG);
        if (!isMember) return c.redirect("/login?error=not_member");
      }
      if (!profile.email) {
        profile.email = await githubClient.getPrimaryEmail(accessToken);
      }
      // Adoption keys on verified emails only (see upsertGithubUser SECURITY).
      const verifiedEmails = await githubClient.getVerifiedEmails(accessToken);

      const user = await upsertGithubUser(db, profile, verifiedEmails);
      const role = user.role === "admin" ? "admin" : "user";
      const cookieToken = await signToken(
        { sub: user.id, email: emailForToken(user.email, profile.login), role, aud: "web" },
        env.JWT_SECRET,
      );
      setCookie(c, "session", cookieToken, {
        httpOnly: true,
        secure: cookieSecure,
        sameSite: "Lax",
        path: "/",
        maxAge: 60 * 60 * 24 * 7,
      });
      return c.redirect(from);
    } catch (err) {
      console.error("github oauth callback failed", err);
      return c.redirect("/login?error=oauth");
    }
  });

  router.get("/me", requireAuth, async (c) => {
    const user = c.get("user");
    const rows = await db
      .select({ githubLogin: users.githubLogin, avatarUrl: users.avatarUrl })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1);
    return c.json({
      user: {
        ...user,
        github_login: rows[0]?.githubLogin ?? null,
        avatar_url: rows[0]?.avatarUrl ?? null,
      },
    });
  });

  router.post("/logout", (c) => {
    deleteCookie(c, "session", { path: "/" });
    return c.json({ ok: true });
  });

  // POST /api/auth/mcp-token — issue a fresh JWT scoped for the MCP transport
  // (REQ-047). Caller must already be authenticated via cookie or bearer.
  router.post("/mcp-token", requireAuth, async (c) => {
    const user = c.get("user");
    const token = await signToken(
      { sub: user.id, email: user.email, role: user.role, aud: "mcp" },
      env.JWT_SECRET,
    );
    return c.json({ token });
  });

  router.post("/cli-code", requireAuth, (c) => {
    const user = c.get("user");
    const now = Date.now();
    sweepExpired(now);
    const code = generatePairCode();
    pairCodes.set(code, {
      userId: user.id,
      email: user.email,
      role: user.role,
      expiresAt: now + PAIR_TTL_MS,
    });
    return c.json({ code, expiresInSeconds: PAIR_TTL_MS / 1000 });
  });

  router.post("/cli-exchange", async (c) => {
    const json = await c.req.json().catch(() => null);
    const parsed = exchangeSchema.safeParse(json);
    if (!parsed.success) return c.json({ error: "invalid code" }, 400);
    const code = parsed.data.code.trim().toUpperCase();
    const now = Date.now();
    sweepExpired(now);
    const entry = pairCodes.get(code);
    if (!entry || entry.expiresAt <= now) {
      return c.json({ error: "invalid or expired code" }, 401);
    }
    pairCodes.delete(code);
    const token = await signToken(
      { sub: entry.userId, email: entry.email, role: entry.role, aud: "cli" },
      env.JWT_SECRET,
    );
    return c.json({
      token,
      user: { id: entry.userId, email: entry.email, role: entry.role },
    });
  });

  return router;
};
