CREATE TABLE "learningSessions" (
	"learningId" uuid NOT NULL,
	"sessionId" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "learningSessions_learningId_sessionId_pk" PRIMARY KEY("learningId","sessionId")
);
--> statement-breakpoint
ALTER TABLE "learningSessions" ADD CONSTRAINT "learningSessions_learningId_learnings_id_fk" FOREIGN KEY ("learningId") REFERENCES "public"."learnings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learningSessions" ADD CONSTRAINT "learningSessions_sessionId_sessions_id_fk" FOREIGN KEY ("sessionId") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "learningSessions_sessionId_idx" ON "learningSessions" USING btree ("sessionId");