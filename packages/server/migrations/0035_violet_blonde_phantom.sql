ALTER TABLE "learnings" ADD COLUMN "impact" text;--> statement-breakpoint
ALTER TABLE "learnings" ADD COLUMN "impactReason" text;--> statement-breakpoint
ALTER TABLE "learnings" ADD COLUMN "howItHelps" text;--> statement-breakpoint
ALTER TABLE "learnings" ADD CONSTRAINT "learnings_impact_check" CHECK ("learnings"."impact" in ('wrong_result', 'person_stepped_in', 'time_only'));