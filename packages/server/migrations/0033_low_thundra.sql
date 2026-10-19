DROP TABLE "learningSessions" CASCADE;--> statement-breakpoint
DROP TABLE "learnings" CASCADE;--> statement-breakpoint
CREATE TABLE "learningRuns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"orgId" uuid NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"harnessRef" text,
	"error" text,
	"startedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"finishedAt" timestamp with time zone,
	CONSTRAINT "learningRuns_status_check" CHECK ("learningRuns"."status" in ('running', 'done', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "learnings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"orgId" uuid NOT NULL,
	"updatedByRunId" uuid NOT NULL,
	"title" text NOT NULL,
	"cause" text NOT NULL,
	"problem" text NOT NULL,
	"priority" text NOT NULL,
	"priorityReason" text NOT NULL,
	"fixType" text NOT NULL,
	"fix" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "learnings_priority_check" CHECK ("learnings"."priority" in ('high', 'medium', 'low')),
	CONSTRAINT "learnings_fixType_check" CHECK ("learnings"."fixType" in ('skill', 'code', 'project_guidelines', 'knowledge_base', 'human'))
);
--> statement-breakpoint
ALTER TABLE "reviewProblems" ADD COLUMN "learningRunId" uuid;--> statement-breakpoint
ALTER TABLE "reviewProblems" ADD COLUMN "learningId" uuid;--> statement-breakpoint
ALTER TABLE "learningRuns" ADD CONSTRAINT "learningRuns_orgId_orgs_id_fk" FOREIGN KEY ("orgId") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learnings" ADD CONSTRAINT "learnings_orgId_orgs_id_fk" FOREIGN KEY ("orgId") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learnings" ADD CONSTRAINT "learnings_updatedByRunId_learningRuns_id_fk" FOREIGN KEY ("updatedByRunId") REFERENCES "public"."learningRuns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "learningRuns_orgId_startedAt_idx" ON "learningRuns" USING btree ("orgId","startedAt");--> statement-breakpoint
CREATE UNIQUE INDEX "learningRuns_one_running_per_org" ON "learningRuns" USING btree ("orgId") WHERE "learningRuns"."status" = 'running';--> statement-breakpoint
CREATE INDEX "learnings_orgId_idx" ON "learnings" USING btree ("orgId");--> statement-breakpoint
ALTER TABLE "reviewProblems" ADD CONSTRAINT "reviewProblems_learningRunId_learningRuns_id_fk" FOREIGN KEY ("learningRunId") REFERENCES "public"."learningRuns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviewProblems" ADD CONSTRAINT "reviewProblems_learningId_learnings_id_fk" FOREIGN KEY ("learningId") REFERENCES "public"."learnings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reviewProblems_learningId_idx" ON "reviewProblems" USING btree ("learningId");--> statement-breakpoint
CREATE INDEX "reviewProblems_learningRunId_idx" ON "reviewProblems" USING btree ("learningRunId");