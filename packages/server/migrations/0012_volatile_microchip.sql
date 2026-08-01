CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "sessionChunk" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sessionId" text NOT NULL,
	"kind" text NOT NULL,
	"trackId" text,
	"agentId" text,
	"partIndex" integer DEFAULT 0 NOT NULL,
	"startLineNumber" integer,
	"endLineNumber" integer,
	"anchorMessageId" uuid,
	"searchText" text NOT NULL,
	"embedText" text NOT NULL,
	"embedding" vector(1024),
	"claimedAt" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessionChunk_identity_unique" UNIQUE("sessionId","kind","trackId","startLineNumber","partIndex"),
	CONSTRAINT "sessionChunk_kind_check" CHECK ("sessionChunk"."kind" in ('turn', 'title'))
);
--> statement-breakpoint
ALTER TABLE "sessionChunk" ADD CONSTRAINT "sessionChunk_sessionId_sessions_id_fk" FOREIGN KEY ("sessionId") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessionChunk" ADD CONSTRAINT "sessionChunk_anchorMessageId_messages_id_fk" FOREIGN KEY ("anchorMessageId") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sessionChunk_sessionId_idx" ON "sessionChunk" USING btree ("sessionId");
--> statement-breakpoint
CREATE INDEX "sessionChunk_searchText_gin"
  ON "sessionChunk" USING gin (to_tsvector('english', "searchText"));
