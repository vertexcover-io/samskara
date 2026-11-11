ALTER TABLE "sessionReviews" ALTER COLUMN "outcome" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sessionReviews" ALTER COLUMN "summary" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sessionReviews" ALTER COLUMN "signals" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sessionReviews" ADD COLUMN "status" text DEFAULT 'done' NOT NULL;--> statement-breakpoint
ALTER TABLE "sessionReviews" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sessionReviews" ADD COLUMN "error" text;--> statement-breakpoint
ALTER TABLE "sessionReviews" ADD COLUMN "heartbeatAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessionReviews" ADD COLUMN "reviewedThrough" integer;--> statement-breakpoint
CREATE INDEX "sessionReviews_status_updatedAt_idx" ON "sessionReviews" USING btree ("status","updatedAt") WHERE "sessionReviews"."status" in ('waiting', 'running');--> statement-breakpoint
ALTER TABLE "sessionReviews" ADD CONSTRAINT "sessionReviews_status_check" CHECK ("sessionReviews"."status" in ('waiting', 'running', 'done', 'failed'));--> statement-breakpoint
ALTER TABLE "sessionReviews" ADD CONSTRAINT "sessionReviews_done_has_result_check" CHECK ("sessionReviews"."status" <> 'done' or ("sessionReviews"."outcome" is not null and "sessionReviews"."summary" is not null and "sessionReviews"."signals" is not null));