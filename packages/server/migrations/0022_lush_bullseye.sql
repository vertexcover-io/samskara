ALTER TABLE "repos" DROP CONSTRAINT "repos_identity_unique";--> statement-breakpoint
ALTER TABLE "repos" ALTER COLUMN "userId" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "ownerOrgId" uuid;--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_ownerOrgId_orgs_id_fk" FOREIGN KEY ("ownerOrgId") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "repos_identity_owner_user_unique" ON "repos" USING btree ("host","owner","repoName","userId") WHERE "repos"."ownerOrgId" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "repos_identity_owner_org_unique" ON "repos" USING btree ("host","owner","repoName","ownerOrgId") WHERE "repos"."userId" is null;--> statement-breakpoint
CREATE INDEX "repos_owner_org_idx" ON "repos" USING btree ("ownerOrgId");--> statement-breakpoint
ALTER TABLE "repos" DROP COLUMN "ownerType";--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_one_owner_check" CHECK (("repos"."userId" is null) <> ("repos"."ownerOrgId" is null));