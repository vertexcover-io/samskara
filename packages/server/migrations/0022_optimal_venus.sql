CREATE TABLE "learnings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"projectId" uuid NOT NULL,
	"audience" text NOT NULL,
	"category" text NOT NULL,
	"title" text NOT NULL,
	"detail" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"fingerprint" text NOT NULL,
	"status" text DEFAULT 'candidate' NOT NULL,
	"occurrenceCount" integer DEFAULT 1 NOT NULL,
	"sourceReviewId" uuid,
	"firstSeenAt" timestamp with time zone DEFAULT now() NOT NULL,
	"lastSeenAt" timestamp with time zone DEFAULT now() NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "learnings_project_fingerprint_unique" UNIQUE("projectId","fingerprint"),
	CONSTRAINT "learnings_audience_check" CHECK ("learnings"."audience" in ('agent', 'human')),
	CONSTRAINT "learnings_status_check" CHECK ("learnings"."status" in ('candidate', 'accepted', 'superseded'))
);
--> statement-breakpoint
CREATE TABLE "sessionReviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sessionId" text NOT NULL,
	"projectId" uuid NOT NULL,
	"analyzer" text NOT NULL,
	"outcome" text NOT NULL,
	"friction" text NOT NULL,
	"summary" text NOT NULL,
	"signals" jsonb NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessionReviews_session_analyzer_unique" UNIQUE("sessionId","analyzer"),
	CONSTRAINT "sessionReviews_outcome_check" CHECK ("sessionReviews"."outcome" in ('shipped', 'productive', 'struggled', 'aborted')),
	CONSTRAINT "sessionReviews_friction_check" CHECK ("sessionReviews"."friction" in ('none', 'moderate', 'high'))
);
--> statement-breakpoint
ALTER TABLE "learnings" ADD CONSTRAINT "learnings_projectId_projects_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learnings" ADD CONSTRAINT "learnings_sourceReviewId_sessionReviews_id_fk" FOREIGN KEY ("sourceReviewId") REFERENCES "public"."sessionReviews"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessionReviews" ADD CONSTRAINT "sessionReviews_sessionId_sessions_id_fk" FOREIGN KEY ("sessionId") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessionReviews" ADD CONSTRAINT "sessionReviews_projectId_projects_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "learnings_project_status_idx" ON "learnings" USING btree ("projectId","status");--> statement-breakpoint
CREATE INDEX "learnings_audience_idx" ON "learnings" USING btree ("audience");--> statement-breakpoint
CREATE INDEX "sessionReviews_project_idx" ON "sessionReviews" USING btree ("projectId");