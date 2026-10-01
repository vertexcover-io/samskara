CREATE TABLE "reviewProblems" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reviewId" uuid NOT NULL,
	"sessionId" text NOT NULL,
	"projectId" uuid NOT NULL,
	"position" integer NOT NULL,
	"title" text NOT NULL,
	"class" text NOT NULL,
	"severity" text NOT NULL,
	"severityReason" text NOT NULL,
	"fixType" text NOT NULL,
	"description" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"learning" text NOT NULL,
	"extra" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reviewProblems_class_check" CHECK ("reviewProblems"."class" in ('missed', 'blocked', 'slow', 'caught')),
	CONSTRAINT "reviewProblems_severity_check" CHECK ("reviewProblems"."severity" in ('high', 'medium', 'low')),
	CONSTRAINT "reviewProblems_fixType_check" CHECK ("reviewProblems"."fixType" in ('skill', 'code', 'project_guidelines', 'knowledge_base', 'human'))
);
--> statement-breakpoint
ALTER TABLE "reviewProblems" ADD CONSTRAINT "reviewProblems_reviewId_sessionReviews_id_fk" FOREIGN KEY ("reviewId") REFERENCES "public"."sessionReviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviewProblems" ADD CONSTRAINT "reviewProblems_sessionId_sessions_id_fk" FOREIGN KEY ("sessionId") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviewProblems" ADD CONSTRAINT "reviewProblems_projectId_projects_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reviewProblems_reviewId_idx" ON "reviewProblems" USING btree ("reviewId");--> statement-breakpoint
CREATE INDEX "reviewProblems_projectId_idx" ON "reviewProblems" USING btree ("projectId");