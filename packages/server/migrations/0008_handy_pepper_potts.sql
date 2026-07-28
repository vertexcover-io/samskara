CREATE TABLE "pullRequests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repoId" uuid NOT NULL,
	"number" integer NOT NULL,
	"title" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pullRequests_repo_number_unique" UNIQUE("repoId","number")
);
--> statement-breakpoint
CREATE TABLE "sessionPullRequests" (
	"sessionId" text NOT NULL,
	"prId" uuid NOT NULL,
	"createdHere" boolean DEFAULT false NOT NULL,
	"messageId" uuid,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessionPullRequests_sessionId_prId_pk" PRIMARY KEY("sessionId","prId")
);
--> statement-breakpoint
ALTER TABLE "pullRequests" ADD CONSTRAINT "pullRequests_repoId_repos_id_fk" FOREIGN KEY ("repoId") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessionPullRequests" ADD CONSTRAINT "sessionPullRequests_sessionId_sessions_id_fk" FOREIGN KEY ("sessionId") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessionPullRequests" ADD CONSTRAINT "sessionPullRequests_prId_pullRequests_id_fk" FOREIGN KEY ("prId") REFERENCES "public"."pullRequests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessionPullRequests" ADD CONSTRAINT "sessionPullRequests_messageId_messages_id_fk" FOREIGN KEY ("messageId") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sessionPullRequests_prId_idx" ON "sessionPullRequests" USING btree ("prId");