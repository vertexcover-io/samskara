DROP TABLE "token_usage" CASCADE;--> statement-breakpoint
DROP TABLE "subagents" CASCADE;--> statement-breakpoint
DROP TABLE "messages" CASCADE;--> statement-breakpoint
DROP TABLE "sessions" CASCADE;--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"userId" uuid NOT NULL,
	"repoId" uuid NOT NULL,
	"model" text,
	"provider" text,
	"title" text,
	"cwd" text,
	"gitBranch" text,
	"gitCommit" text,
	"cliVersion" text,
	"permissionMode" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sessionId" text NOT NULL,
	"lineUuid" text NOT NULL,
	"subIndex" integer NOT NULL,
	"parentUuid" text,
	"msgType" text NOT NULL,
	"role" text,
	"timestamp" timestamp with time zone,
	"lineNumber" integer NOT NULL,
	"model" text,
	"provider" text,
	"content" text,
	"thinking" text,
	"raw" jsonb NOT NULL,
	"sourceSchemaVersion" integer NOT NULL,
	"isSubagent" boolean DEFAULT false NOT NULL,
	"agentId" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_line_identity" UNIQUE("lineUuid","subIndex"),
	CONSTRAINT "messages_msgType_check" CHECK ("messages"."msgType" in ('user', 'assistant', 'system', 'toolCall', 'toolResult', 'progress', 'systemEvent', 'queueOperation', 'fileSnapshot', 'summary'))
);
--> statement-breakpoint
CREATE TABLE "toolCall" (
	"toolId" text NOT NULL,
	"messageId" uuid NOT NULL,
	"toolName" text NOT NULL,
	"toolInput" jsonb,
	CONSTRAINT "toolCall_toolId_messageId_pk" PRIMARY KEY("toolId","messageId")
);
--> statement-breakpoint
CREATE TABLE "toolResult" (
	"toolId" text NOT NULL,
	"messageId" uuid NOT NULL,
	"result" text,
	"status" text NOT NULL,
	CONSTRAINT "toolResult_toolId_messageId_pk" PRIMARY KEY("toolId","messageId"),
	CONSTRAINT "toolResult_status_check" CHECK ("toolResult"."status" in ('success', 'failure'))
);
--> statement-breakpoint
CREATE TABLE "tokenUsage" (
	"messageId" uuid PRIMARY KEY NOT NULL,
	"inputTokens" integer DEFAULT 0 NOT NULL,
	"outputTokens" integer DEFAULT 0 NOT NULL,
	"cachedTokens" integer DEFAULT 0 NOT NULL,
	"thinkingTokens" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subagents" (
	"agentId" text NOT NULL,
	"sessionId" text NOT NULL,
	"agentType" text,
	"description" text,
	"spawnDepth" integer,
	"spawnToolUseId" text,
	"parentAgentId" text,
	"sourceRelativePath" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subagents_sessionId_agentId_pk" PRIMARY KEY("sessionId","agentId")
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_repoId_repos_id_fk" FOREIGN KEY ("repoId") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sessionId_sessions_id_fk" FOREIGN KEY ("sessionId") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "toolCall" ADD CONSTRAINT "toolCall_messageId_messages_id_fk" FOREIGN KEY ("messageId") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "toolResult" ADD CONSTRAINT "toolResult_messageId_messages_id_fk" FOREIGN KEY ("messageId") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tokenUsage" ADD CONSTRAINT "tokenUsage_messageId_messages_id_fk" FOREIGN KEY ("messageId") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subagents" ADD CONSTRAINT "subagents_sessionId_sessions_id_fk" FOREIGN KEY ("sessionId") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messages_session_line_idx" ON "messages" USING btree ("sessionId","lineNumber");--> statement-breakpoint
CREATE INDEX "messages_session_agent_idx" ON "messages" USING btree ("sessionId","agentId");--> statement-breakpoint
CREATE INDEX "messages_agent_id_idx" ON "messages" USING btree ("agentId") WHERE "messages"."isSubagent";--> statement-breakpoint
CREATE INDEX "toolCall_message_idx" ON "toolCall" USING btree ("messageId");--> statement-breakpoint
CREATE INDEX "toolCall_tool_idx" ON "toolCall" USING btree ("toolId");--> statement-breakpoint
CREATE INDEX "toolResult_message_idx" ON "toolResult" USING btree ("messageId");--> statement-breakpoint
CREATE INDEX "toolResult_tool_idx" ON "toolResult" USING btree ("toolId");--> statement-breakpoint
CREATE INDEX "subagents_session_id_idx" ON "subagents" USING btree ("sessionId");--> statement-breakpoint
CREATE INDEX "subagents_parent_agent_id_idx" ON "subagents" USING btree ("parentAgentId");--> statement-breakpoint
CREATE OR REPLACE FUNCTION set_updatedAt_camel() RETURNS trigger AS $$
BEGIN NEW."updatedAt" = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER sessions_set_updated_at BEFORE UPDATE ON "sessions"
  FOR EACH ROW EXECUTE FUNCTION set_updatedAt_camel();--> statement-breakpoint
CREATE TRIGGER subagents_set_updated_at BEFORE UPDATE ON "subagents"
  FOR EACH ROW EXECUTE FUNCTION set_updatedAt_camel();
