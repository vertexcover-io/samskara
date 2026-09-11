DROP INDEX "repos_identity_owner_user_unique";--> statement-breakpoint
DROP INDEX "repos_identity_owner_org_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "repos_identity_owner_user_unique" ON "repos" USING btree (lower("host"),lower("owner"),lower("repoName"),"userId") WHERE "repos"."ownerOrgId" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "repos_identity_owner_org_unique" ON "repos" USING btree (lower("host"),lower("owner"),lower("repoName"),"ownerOrgId") WHERE "repos"."userId" is null;--> statement-breakpoint
ALTER TABLE "repos" DROP COLUMN "ownerType";