ALTER TABLE "projects" DROP CONSTRAINT "projects_slug_owner_unique";--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "ownerId" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "orgs" ADD COLUMN "autoAddMembers" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "ownerOrgId" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_ownerOrgId_orgs_id_fk" FOREIGN KEY ("ownerOrgId") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "projects_slug_owner_user_unique" ON "projects" USING btree ("slug","ownerId") WHERE "projects"."ownerOrgId" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "projects_slug_owner_org_unique" ON "projects" USING btree ("slug","ownerOrgId") WHERE "projects"."ownerId" is null;--> statement-breakpoint
CREATE INDEX "projects_owner_org_idx" ON "projects" USING btree ("ownerOrgId");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_one_owner_check" CHECK (("projects"."ownerId" is null) <> ("projects"."ownerOrgId" is null));
--> statement-breakpoint
UPDATE "orgs" SET "autoAddMembers" = true;