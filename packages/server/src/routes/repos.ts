// AI-generated. See PROMPT.md for the prompts and model used.

import { canonicalizeRepo } from "@claude-sessions/core";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { type AuthVariables, buildRequireAuth } from "../auth/middleware.js";
import type { DbClient } from "../db/client.js";
import { findUserRepoAccess, grantUserRepo, revokeUserRepo, upsertRepo } from "../db/repos.js";
import { repos, sessions, summaries, userRepos, users } from "../db/schema.js";
import type { Env } from "../env.js";

const enableSchema = z.object({
  canonical_url: z.string().min(1),
  local_path: z.string().optional(),
});

const disableSchema = z.object({
  canonical_url: z.string().min(1),
  purge: z.boolean().optional().default(false),
});

export const buildReposRouter = (db: DbClient, env: Env): Hono<{ Variables: AuthVariables }> => {
  const router = new Hono<{ Variables: AuthVariables }>();
  router.use("*", buildRequireAuth(env));

  /**
   * GET /api/repos — list every repo that has at least one (non-private)
   * session, org-wide, with a global session count and last-activity. Drives
   * the Home grid. `access` reflects the caller's own grant if any (else
   * "read"), but visibility is global.
   */
  router.get("/", async (c) => {
    const user = c.get("user");
    const rows = await db
      .select({
        id: repos.id,
        canonicalUrl: repos.canonicalUrl,
        displayName: repos.displayName,
        access: sql<string>`coalesce(${userRepos.access}, 'read')`,
        sessionCount: sql<number>`coalesce(count(${sessions.id})::int, 0)`,
        // postgres-js returns aggregate timestamps as ISO strings (not Date),
        // even when the column type is timestamptz. Coerce to ISO at the edge.
        lastActivity: sql<string | null>`max(${sessions.startedAt})`,
      })
      .from(repos)
      .innerJoin(sessions, and(eq(sessions.repoId, repos.id), eq(sessions.isPrivate, false)))
      .leftJoin(userRepos, and(eq(userRepos.repoId, repos.id), eq(userRepos.userId, user.id)))
      .groupBy(repos.id, userRepos.access)
      .orderBy(desc(sql`max(${sessions.startedAt})`));

    return c.json({
      repos: rows.map((r) => ({
        id: r.id,
        canonical_url: r.canonicalUrl,
        display_name: r.displayName,
        access: r.access,
        session_count: r.sessionCount ?? 0,
        last_activity: r.lastActivity ? new Date(r.lastActivity).toISOString() : null,
      })),
    });
  });

  /**
   * GET /api/repos/sessions?repo=<canonical_url> — list sessions for a single
   * repo, newest first. `repo` is the canonical_url passed as a query param
   * (not a path segment) so embedded slashes survive proxies that normalize
   * encoded slashes in the path (e.g. Azure App Service decodes %2F → /).
   */
  router.get("/sessions", async (c) => {
    const canonical = c.req.query("repo") ?? "";
    if (!canonical) return c.json({ repo: null, sessions: [] }, 400);
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50), 1), 200);
    // Repeated query params (?user=a&user=b) accumulate into OR-sets, so each
    // filter narrows to "any of the selected values".
    const userFilters = c.req.queries("user") ?? [];
    const branchFilters = c.req.queries("branch") ?? [];

    const repoRow = await db
      .select({ id: repos.id })
      .from(repos)
      .where(eq(repos.canonicalUrl, canonical))
      .limit(1);
    if (!repoRow[0]) return c.json({ repo: null, sessions: [] }, 404);

    const filters = [eq(sessions.repoId, repoRow[0].id), eq(sessions.isPrivate, false)];
    if (userFilters.length > 0) {
      const lowered = userFilters.map((u) => u.toLowerCase());
      filters.push(inArray(sql`lower(${users.githubLogin})`, lowered));
    }
    if (branchFilters.length > 0) {
      filters.push(inArray(sessions.branch, branchFilters));
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
        title: summaries.title,
        summary: summaries.summary,
        tags: summaries.tags,
        prsReferenced: summaries.prsReferenced,
        authorLogin: users.githubLogin,
        authorAvatar: users.avatarUrl,
      })
      .from(sessions)
      .leftJoin(summaries, eq(summaries.sessionId, sessions.id))
      .leftJoin(users, eq(users.id, sessions.userId))
      .where(and(...filters))
      .orderBy(desc(sessions.startedAt))
      .limit(limit);

    return c.json({
      repo: { canonical_url: canonical },
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
   * GET /api/repos/facets?repo=<canonical_url> — distinct branches and session
   * authors scoped to THIS repo's non-private sessions. Powers the repo-view
   * filter bar so its dropdowns only list values that actually occur in the
   * project (e.g. the user menu shows only members who pushed ≥1 session here).
   * `repo` is a query param for the same proxy-safety reason as /sessions.
   */
  router.get("/facets", async (c) => {
    const canonical = c.req.query("repo") ?? "";
    if (!canonical) return c.json({ branches: [], users: [] }, 400);

    const repoRow = await db
      .select({ id: repos.id })
      .from(repos)
      .where(eq(repos.canonicalUrl, canonical))
      .limit(1);
    if (!repoRow[0]) return c.json({ branches: [], users: [] }, 404);

    const scoped = and(eq(sessions.repoId, repoRow[0].id), eq(sessions.isPrivate, false));

    const branchRows = await db
      .select({ branch: sessions.branch })
      .from(sessions)
      .where(and(scoped, isNotNull(sessions.branch)))
      .groupBy(sessions.branch)
      .orderBy(sessions.branch);

    const userRows = await db
      .select({
        github_login: users.githubLogin,
        avatar_url: users.avatarUrl,
        count: sql<number>`count(${sessions.id})::int`,
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(scoped, isNotNull(users.githubLogin)))
      .groupBy(users.githubLogin, users.avatarUrl)
      .orderBy(desc(sql`count(${sessions.id})`));

    return c.json({
      branches: branchRows.map((r) => r.branch).filter((b): b is string => b !== null),
      users: userRows
        .filter(
          (r): r is { github_login: string; avatar_url: string | null; count: number } =>
            r.github_login !== null,
        )
        .map((r) => ({
          github_login: r.github_login,
          avatar_url: r.avatar_url,
          count: r.count,
        })),
    });
  });

  router.post("/enable", async (c) => {
    const user = c.get("user");
    const parsed = enableSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const repo = await upsertRepo(db, parsed.data.canonical_url);
    await grantUserRepo(db, user.id, repo.id, "owner");
    return c.json({
      ok: true,
      repo: { id: repo.id, canonical_url: repo.canonicalUrl },
    });
  });

  router.post("/disable", async (c) => {
    const user = c.get("user");
    const parsed = disableSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const canonical = canonicalizeRepo(parsed.data.canonical_url);
    const repo = await upsertRepo(db, canonical);
    const access = await findUserRepoAccess(db, user.id, repo.id);
    if (!access) return c.json({ ok: true, removed: false });
    await revokeUserRepo(db, user.id, repo.id);
    let purgedSessions = 0;
    if (parsed.data.purge) {
      const deleted = await db
        .delete(sessions)
        .where(and(eq(sessions.userId, user.id), eq(sessions.repoId, repo.id)))
        .returning({ id: sessions.id });
      purgedSessions = deleted.length;
    }
    return c.json({ ok: true, removed: true, purged_sessions: purgedSessions });
  });

  return router;
};
