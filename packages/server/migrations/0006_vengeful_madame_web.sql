ALTER TABLE "messages" ADD COLUMN "repoId" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "startCommit" text;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_repoId_repos_id_fk" FOREIGN KEY ("repoId") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messages_repo_id_idx" ON "messages" USING btree ("repoId");