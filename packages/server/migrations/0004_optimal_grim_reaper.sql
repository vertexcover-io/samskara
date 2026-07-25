DROP TABLE IF EXISTS "toolCall" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "toolResult" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "tokenUsage" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "messages" CASCADE;--> statement-breakpoint
CREATE TABLE "messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "sessionId" text NOT NULL,
  "lineUuid" uuid NOT NULL,
  "subIndex" integer NOT NULL,
  "parentUuid" text,
  "msgType" text NOT NULL,
  "subType" text,
  "role" text,
  "timestamp" timestamp with time zone,
  "lineNumber" integer NOT NULL,
  "source" text DEFAULT 'claude_code' NOT NULL,
  "sourceRelativePath" text DEFAULT 'unknown' NOT NULL,
  "trackId" text DEFAULT 'main' NOT NULL,
  "model" text,
  "provider" text,
  "content" jsonb,
  "details" jsonb,
  "raw" jsonb NOT NULL,
  "sourceSchemaVersion" integer NOT NULL,
  "isSubagent" boolean DEFAULT false NOT NULL,
  "agentId" text,
  "gitBranch" text,
  "gitCommit" text,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "messages_line_identity" UNIQUE("sessionId", "lineUuid", "subIndex"),
  CONSTRAINT "messages_msgType_check" CHECK ("msgType" in ('message', 'toolCall', 'toolResult', 'progress', 'hookCall', 'queueOperation', 'turnEvent', 'compaction', 'localCommand', 'fileEvent', 'usage', 'systemEvent', 'custom')),
  CONSTRAINT "messages_role_check" CHECK ("role" is null or "role" in ('user', 'assistant', 'system', 'developer', 'unknown'))
);--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sessionId_sessions_id_fk" FOREIGN KEY ("sessionId") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messages_session_line_idx" ON "messages" USING btree ("sessionId", "lineNumber");--> statement-breakpoint
CREATE INDEX "messages_session_agent_idx" ON "messages" USING btree ("sessionId", "agentId");--> statement-breakpoint
CREATE INDEX "messages_agent_id_idx" ON "messages" USING btree ("agentId") WHERE "messages"."isSubagent";--> statement-breakpoint
CREATE TABLE "toolCall" (
  "toolId" text NOT NULL,
  "messageId" uuid NOT NULL,
  "toolName" text NOT NULL,
  "toolInput" jsonb,
  CONSTRAINT "toolCall_toolId_messageId_pk" PRIMARY KEY("toolId", "messageId")
);--> statement-breakpoint
ALTER TABLE "toolCall" ADD CONSTRAINT "toolCall_messageId_messages_id_fk" FOREIGN KEY ("messageId") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "toolCall_message_idx" ON "toolCall" USING btree ("messageId");--> statement-breakpoint
CREATE INDEX "toolCall_tool_idx" ON "toolCall" USING btree ("toolId");--> statement-breakpoint
CREATE TABLE "toolResult" (
  "toolId" text NOT NULL,
  "messageId" uuid NOT NULL,
  "result" jsonb,
  "status" text NOT NULL,
  CONSTRAINT "toolResult_toolId_messageId_pk" PRIMARY KEY("toolId", "messageId"),
  CONSTRAINT "toolResult_status_check" CHECK ("status" in ('success', 'failure', 'cancelled', 'unknown'))
);--> statement-breakpoint
ALTER TABLE "toolResult" ADD CONSTRAINT "toolResult_messageId_messages_id_fk" FOREIGN KEY ("messageId") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "toolResult_message_idx" ON "toolResult" USING btree ("messageId");--> statement-breakpoint
CREATE INDEX "toolResult_tool_idx" ON "toolResult" USING btree ("toolId");--> statement-breakpoint
CREATE TABLE "tokenUsage" (
  "messageId" uuid PRIMARY KEY NOT NULL,
  "inputTokens" integer DEFAULT 0 NOT NULL,
  "outputTokens" integer DEFAULT 0 NOT NULL,
  "cachedTokens" integer DEFAULT 0 NOT NULL,
  "thinkingTokens" integer DEFAULT 0 NOT NULL
);--> statement-breakpoint
ALTER TABLE "tokenUsage" ADD CONSTRAINT "tokenUsage_messageId_messages_id_fk" FOREIGN KEY ("messageId") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;
