CREATE TABLE "compoundLearnings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"userId" uuid NOT NULL,
	"eventId" text NOT NULL,
	"sessionId" text NOT NULL,
	"occurredAt" timestamp with time zone NOT NULL,
	"cwd" text,
	"trigger" text NOT NULL,
	"whyTriggered" text NOT NULL,
	"evidenceFromMessage" text,
	"evidenceToMessage" text,
	"skillVersion" text,
	"optionsShown" jsonb,
	"proposedLearning" text NOT NULL,
	"optionUserPicked" text,
	"outcome" text NOT NULL,
	"status" text,
	"finalLearning" text,
	"rejectionReason" text,
	"learningFile" text,
	"replaces" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "compoundLearnings_user_eventId_unique" UNIQUE("userId","eventId")
);
--> statement-breakpoint
ALTER TABLE "compoundLearnings" ADD CONSTRAINT "compoundLearnings_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "compoundLearnings_user_occurred_idx" ON "compoundLearnings" USING btree ("userId","occurredAt");