ALTER TABLE "learnings" ADD COLUMN "skippedAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "learnings" ADD COLUMN "skippedBy" uuid;--> statement-breakpoint
ALTER TABLE "learnings" ADD CONSTRAINT "learnings_skippedBy_users_id_fk" FOREIGN KEY ("skippedBy") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;