ALTER TABLE "sessionReviews" ADD COLUMN "harness" text;--> statement-breakpoint
ALTER TABLE "sessionReviews" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "sessionReviews" ADD COLUMN "prompt" text;--> statement-breakpoint
ALTER TABLE "sessionReviews" DROP COLUMN "heartbeatAt";