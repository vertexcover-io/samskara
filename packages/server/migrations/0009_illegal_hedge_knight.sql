ALTER TABLE "repos" DROP CONSTRAINT "repos_identity_unique";--> statement-breakpoint
ALTER TABLE "repos" DROP CONSTRAINT "repos_owner_type_check";--> statement-breakpoint
ALTER TABLE "repos" ALTER COLUMN "owner_type" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "userId" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_identity_unique" UNIQUE("owner","repo_name","userId");