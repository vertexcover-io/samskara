ALTER TABLE "user_orgs" RENAME TO "userOrgs";--> statement-breakpoint
ALTER TABLE "users" RENAME COLUMN "github_id" TO "githubId";--> statement-breakpoint
ALTER TABLE "users" RENAME COLUMN "github_login" TO "githubLogin";--> statement-breakpoint
ALTER TABLE "users" RENAME COLUMN "avatar_url" TO "avatarUrl";--> statement-breakpoint
ALTER TABLE "users" RENAME COLUMN "is_super_admin" TO "isSuperAdmin";--> statement-breakpoint
ALTER TABLE "users" RENAME COLUMN "created_at" TO "createdAt";--> statement-breakpoint
ALTER TABLE "users" RENAME COLUMN "updated_at" TO "updatedAt";--> statement-breakpoint
ALTER TABLE "orgs" RENAME COLUMN "github_org_id" TO "githubOrgId";--> statement-breakpoint
ALTER TABLE "orgs" RENAME COLUMN "github_slug" TO "githubSlug";--> statement-breakpoint
ALTER TABLE "orgs" RENAME COLUMN "created_at" TO "createdAt";--> statement-breakpoint
ALTER TABLE "orgs" RENAME COLUMN "updated_at" TO "updatedAt";--> statement-breakpoint
ALTER TABLE "repos" RENAME COLUMN "owner_type" TO "ownerType";--> statement-breakpoint
ALTER TABLE "repos" RENAME COLUMN "repo_name" TO "repoName";--> statement-breakpoint
ALTER TABLE "repos" RENAME COLUMN "created_at" TO "createdAt";--> statement-breakpoint
ALTER TABLE "repos" RENAME COLUMN "updated_at" TO "updatedAt";--> statement-breakpoint
ALTER TABLE "userOrgs" RENAME COLUMN "user_id" TO "userId";--> statement-breakpoint
ALTER TABLE "userOrgs" RENAME COLUMN "org_id" TO "orgId";--> statement-breakpoint
ALTER TABLE "userOrgs" RENAME COLUMN "created_at" TO "createdAt";--> statement-breakpoint
ALTER TABLE "users" RENAME CONSTRAINT "users_github_id_unique" TO "users_githubId_unique";--> statement-breakpoint
ALTER TABLE "orgs" RENAME CONSTRAINT "orgs_github_org_id_unique" TO "orgs_githubOrgId_unique";--> statement-breakpoint
ALTER TABLE "orgs" RENAME CONSTRAINT "orgs_github_slug_unique" TO "orgs_githubSlug_unique";--> statement-breakpoint
ALTER TABLE "userOrgs" RENAME CONSTRAINT "user_orgs_user_id_org_id_pk" TO "userOrgs_userId_orgId_pk";--> statement-breakpoint
ALTER TABLE "userOrgs" RENAME CONSTRAINT "user_orgs_user_id_users_id_fk" TO "userOrgs_userId_users_id_fk";--> statement-breakpoint
ALTER TABLE "userOrgs" RENAME CONSTRAINT "user_orgs_org_id_orgs_id_fk" TO "userOrgs_orgId_orgs_id_fk";--> statement-breakpoint
ALTER INDEX "user_orgs_org_id_idx" RENAME TO "userOrgs_orgId_idx";--> statement-breakpoint
DROP TRIGGER IF EXISTS users_set_updated_at ON "users";--> statement-breakpoint
CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON "users"
  FOR EACH ROW EXECUTE FUNCTION set_updatedAt_camel();--> statement-breakpoint
DROP TRIGGER IF EXISTS orgs_set_updated_at ON "orgs";--> statement-breakpoint
CREATE TRIGGER orgs_set_updated_at BEFORE UPDATE ON "orgs"
  FOR EACH ROW EXECUTE FUNCTION set_updatedAt_camel();--> statement-breakpoint
DROP TRIGGER IF EXISTS repos_set_updated_at ON "repos";--> statement-breakpoint
CREATE TRIGGER repos_set_updated_at BEFORE UPDATE ON "repos"
  FOR EACH ROW EXECUTE FUNCTION set_updatedAt_camel();--> statement-breakpoint
DROP FUNCTION IF EXISTS set_updated_at();
