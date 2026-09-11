-- Converges repos stored before they could belong to an org, by the rule `reposRepo.ownerFor`
-- applies to every repo captured today. Data only, and it must run before 0025: that index cannot
-- build while two rows differ only by case.
CREATE TEMPORARY TABLE repo_merge ON COMMIT DROP AS
WITH captured AS (
  SELECT DISTINCT m."repoId", s."userId"
  FROM sessions s
  JOIN messages m ON m."sessionId" = s.id
  WHERE m."repoId" IS NOT NULL
), claimed AS (
  -- `githubSlug` carries no lowercase constraint, so both sides fold.
  SELECT DISTINCT c."repoId", o.id AS "orgId"
  FROM captured c
  JOIN repos r ON r.id = c."repoId" AND lower(r.host) = 'github.com'
  JOIN orgs o ON lower(o."githubSlug") = lower(r.owner)
  JOIN "userOrgs" uo ON uo."orgId" = o.id AND uo."userId" = c."userId"
), settled AS (
  -- Capturers disagreeing keeps the row as it was. `uuid` has no `max()`, hence the cast.
  SELECT "repoId", max("orgId"::text)::uuid AS "orgId"
  FROM claimed GROUP BY "repoId" HAVING count(DISTINCT "orgId") = 1
), target AS (
  SELECT r.id,
    coalesce(s."orgId", r."ownerOrgId") AS "ownerOrgId",
    CASE WHEN coalesce(s."orgId", r."ownerOrgId") IS NOT NULL
      THEN NULL ELSE r."userId" END AS "ownerUserId"
  FROM repos r
  LEFT JOIN settled s ON s."repoId" = r.id
)
SELECT t.id, t."ownerOrgId", t."ownerUserId",
  first_value(t.id) OVER (
    PARTITION BY lower(r.host), lower(r.owner), lower(r."repoName"),
      t."ownerOrgId", t."ownerUserId"
    ORDER BY t.id
  ) AS "survivorId"
FROM target t
JOIN repos r ON r.id = t.id;
--> statement-breakpoint

UPDATE messages SET "repoId" = m."survivorId"
FROM repo_merge m
WHERE messages."repoId" = m.id AND m.id <> m."survivorId";
--> statement-breakpoint

-- `commits` is unique per (repoId, sha) and two rows for one repository hold the same commits, so
-- moving a duplicate onto a survivor that already has it would abort this migration.
DELETE FROM commits c USING repo_merge m
WHERE c."repoId" = m.id AND m.id <> m."survivorId"
  AND EXISTS (
    SELECT 1 FROM commits keep
    WHERE keep."repoId" = m."survivorId" AND keep.sha = c.sha
  );
--> statement-breakpoint

UPDATE commits SET "repoId" = m."survivorId"
FROM repo_merge m
WHERE commits."repoId" = m.id AND m.id <> m."survivorId";
--> statement-breakpoint

-- Session links move before their pull request is deleted, or they cascade away with it.
DELETE FROM "sessionPullRequests" spr
USING "pullRequests" dup, repo_merge m, "pullRequests" keep
WHERE spr."prId" = dup.id AND dup."repoId" = m.id AND m.id <> m."survivorId"
  AND keep."repoId" = m."survivorId" AND keep.number = dup.number
  AND EXISTS (
    SELECT 1 FROM "sessionPullRequests" held
    WHERE held."prId" = keep.id AND held."sessionId" = spr."sessionId"
  );
--> statement-breakpoint

UPDATE "sessionPullRequests" spr SET "prId" = keep.id
FROM "pullRequests" dup, repo_merge m, "pullRequests" keep
WHERE spr."prId" = dup.id AND dup."repoId" = m.id AND m.id <> m."survivorId"
  AND keep."repoId" = m."survivorId" AND keep.number = dup.number;
--> statement-breakpoint

DELETE FROM "pullRequests" dup USING repo_merge m
WHERE dup."repoId" = m.id AND m.id <> m."survivorId"
  AND EXISTS (
    SELECT 1 FROM "pullRequests" keep
    WHERE keep."repoId" = m."survivorId" AND keep.number = dup.number
  );
--> statement-breakpoint

UPDATE "pullRequests" SET "repoId" = m."survivorId"
FROM repo_merge m
WHERE "pullRequests"."repoId" = m.id AND m.id <> m."survivorId";
--> statement-breakpoint

DELETE FROM repos USING repo_merge m
WHERE repos.id = m.id AND m.id <> m."survivorId";
--> statement-breakpoint

UPDATE repos r
SET "ownerOrgId" = m."ownerOrgId", "userId" = m."ownerUserId"
FROM repo_merge m
WHERE r.id = m.id AND m.id = m."survivorId"
  AND (r."ownerOrgId", r."userId") IS DISTINCT FROM (m."ownerOrgId", m."ownerUserId");
--> statement-breakpoint

-- An org project only ever comes from a github.com remote whose owner is that org, with its name
-- set to that remote's repo name -- so its repo is reconstructed, not guessed. A project that
-- captured no repo is skipped, which is how the seeded "Demo Project" avoids inventing one.
INSERT INTO repos (host, owner, "repoName", "ownerOrgId")
SELECT DISTINCT 'github.com', o."githubSlug", p.name, p."ownerOrgId"
FROM projects p
JOIN orgs o ON o.id = p."ownerOrgId"
WHERE p."ownerOrgId" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM sessions s
    JOIN messages m ON m."sessionId" = s.id
    WHERE s."projectId" = p.id AND m."repoId" IS NOT NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM repos r
    WHERE lower(r.host) = 'github.com'
      AND lower(r.owner) = lower(o."githubSlug")
      AND lower(r."repoName") = lower(p.name)
      AND r."ownerOrgId" = p."ownerOrgId"
  );
--> statement-breakpoint

WITH matches AS (
  SELECT p.id AS "projectId", r.id AS "repoId", r.host,
    bool_or(lower(r.host) = 'github.com') OVER (PARTITION BY p.id) AS "hasGithub"
  FROM projects p
  JOIN repos r ON lower(r."repoName") = lower(p.name)
    AND (r."ownerOrgId" = p."ownerOrgId" OR r."userId" = p."ownerId")
  WHERE p."repoId" IS NULL
), preferred AS (
  SELECT "projectId", "repoId" FROM matches
  WHERE ("hasGithub" AND lower(host) = 'github.com') OR NOT "hasGithub"
), counted AS (
  SELECT "projectId", "repoId", count(*) OVER (PARTITION BY "projectId") AS n FROM preferred
)
UPDATE projects p SET "repoId" = c."repoId"
FROM counted c
WHERE p.id = c."projectId" AND c.n = 1;
--> statement-breakpoint

WITH unresolved AS (
  SELECT id FROM projects WHERE "repoId" IS NULL
), dominant AS (
  SELECT s."projectId" AS "projectId", m."repoId" AS "repoId",
    row_number() OVER (
      PARTITION BY s."projectId"
      ORDER BY count(*) DESC, min(m."lineNumber") ASC
    ) AS rn
  FROM sessions s
  JOIN messages m ON m."sessionId" = s.id
  WHERE m."repoId" IS NOT NULL AND s."projectId" IN (SELECT id FROM unresolved)
  GROUP BY s."projectId", m."repoId"
)
UPDATE projects p SET "repoId" = d."repoId"
FROM dominant d
WHERE p.id = d."projectId" AND d.rn = 1;
--> statement-breakpoint

DELETE FROM repos r
WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m."repoId" = r.id)
  AND NOT EXISTS (SELECT 1 FROM commits c WHERE c."repoId" = r.id)
  AND NOT EXISTS (SELECT 1 FROM "pullRequests" pr WHERE pr."repoId" = r.id)
  AND NOT EXISTS (SELECT 1 FROM projects p WHERE p."repoId" = r.id);
