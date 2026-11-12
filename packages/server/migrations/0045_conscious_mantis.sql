ALTER TABLE "pullRequests" ADD COLUMN "state" text DEFAULT 'open' NOT NULL;--> statement-breakpoint
ALTER TABLE "pullRequests" ADD COLUMN "closedAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pullRequests" ADD COLUMN "checkedAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pullRequests" ADD CONSTRAINT "pullRequests_state_check" CHECK ("pullRequests"."state" in ('open', 'merged', 'closed'));