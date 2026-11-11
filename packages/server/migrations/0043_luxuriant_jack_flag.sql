ALTER TABLE "learningRuns" DROP CONSTRAINT "learningRuns_status_check";--> statement-breakpoint
DROP INDEX "learningRuns_one_running_per_project";--> statement-breakpoint
ALTER TABLE "learningRuns" ALTER COLUMN "status" SET DEFAULT 'waiting';--> statement-breakpoint
ALTER TABLE "learningRuns" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "learningRuns" ADD COLUMN "waitForReviews" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "learningRuns" ADD COLUMN "harnessPath" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "fixRunEveryDays" integer DEFAULT 7 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "learningRuns_one_open_per_project" ON "learningRuns" USING btree ("projectId") WHERE "learningRuns"."status" in ('waiting', 'running');--> statement-breakpoint
ALTER TABLE "learningRuns" ADD CONSTRAINT "learningRuns_status_check" CHECK ("learningRuns"."status" in ('waiting', 'running', 'done', 'failed'));--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_fixRunEveryDays_check" CHECK ("projects"."fixRunEveryDays" >= 1);