ALTER TABLE "projects" ADD COLUMN "autoReview" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "lastNightlyPickAt" timestamp with time zone;