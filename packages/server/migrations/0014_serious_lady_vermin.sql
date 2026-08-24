ALTER TABLE "messages" DROP CONSTRAINT "messages_repoId_repos_id_fk";
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_repoId_repos_id_fk" FOREIGN KEY ("repoId") REFERENCES "public"."repos"("id") ON DELETE set null ON UPDATE no action;