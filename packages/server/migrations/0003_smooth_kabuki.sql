CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"ownerId" uuid NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_slug_owner_unique" UNIQUE("slug","ownerId")
);
--> statement-breakpoint
CREATE TABLE "userProjectGrant" (
	"userId" uuid NOT NULL,
	"projectId" uuid NOT NULL,
	"scope" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "userProjectGrant_userId_projectId_pk" PRIMARY KEY("userId","projectId"),
	CONSTRAINT "userProjectGrant_scope_check" CHECK ("userProjectGrant"."scope" in ('admin', 'editor', 'viewer'))
);
--> statement-breakpoint
ALTER TABLE "org_repos" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_repos" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "org_repos" CASCADE;--> statement-breakpoint
DROP TABLE "user_repos" CASCADE;--> statement-breakpoint
ALTER TABLE "sessions" DROP CONSTRAINT "sessions_repoId_repos_id_fk";
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "gitBranch" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "gitCommit" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "projectId" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_ownerId_users_id_fk" FOREIGN KEY ("ownerId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "userProjectGrant" ADD CONSTRAINT "userProjectGrant_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "userProjectGrant" ADD CONSTRAINT "userProjectGrant_projectId_projects_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "userProjectGrant_projectId_idx" ON "userProjectGrant" USING btree ("projectId");--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_projectId_projects_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sessions_projectId_idx" ON "sessions" USING btree ("projectId");--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN "repoId";--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN "gitBranch";--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN "gitCommit";--> statement-breakpoint
CREATE TRIGGER projects_set_updated_at BEFORE UPDATE ON "projects"
  FOR EACH ROW EXECUTE FUNCTION set_updatedAt_camel();
