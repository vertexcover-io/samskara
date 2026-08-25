CREATE TABLE "messages" (
	"uuid" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"parent_uuid" text,
	"type" text NOT NULL,
	"role" text,
	"timestamp" timestamp with time zone,
	"line_number" integer NOT NULL,
	"source_relative_path" text NOT NULL,
	"source_schema_version" integer NOT NULL,
	"model" text,
	"provider" text,
	"content" text,
	"thinking" text,
	"tool_use_id" text,
	"is_subagent" boolean DEFAULT false NOT NULL,
	"agent_id" text,
	"raw" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_type_check" CHECK ("messages"."type" in ('user', 'assistant', 'system', 'attachment'))
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"repo_id" uuid NOT NULL,
	"git_branch" text,
	"git_commit" text,
	"cli_version" text,
	"permission_mode" text,
	"first_event_at" timestamp with time zone,
	"last_event_at" timestamp with time zone,
	"message_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subagents" (
	"agent_id" text NOT NULL,
	"session_id" text NOT NULL,
	"agent_type" text,
	"description" text,
	"spawn_depth" integer,
	"spawn_tool_use_id" text,
	"parent_agent_id" text,
	"source_relative_path" text NOT NULL,
	"first_event_at" timestamp with time zone,
	"last_event_at" timestamp with time zone,
	"message_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subagents_session_id_agent_id_pk" PRIMARY KEY("session_id","agent_id")
);
--> statement-breakpoint
CREATE TABLE "token_usage" (
	"message_uuid" text PRIMARY KEY NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cached_tokens" integer DEFAULT 0 NOT NULL,
	"thinking_tokens" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subagents" ADD CONSTRAINT "subagents_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_usage" ADD CONSTRAINT "token_usage_message_uuid_messages_uuid_fk" FOREIGN KEY ("message_uuid") REFERENCES "public"."messages"("uuid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messages_session_line_idx" ON "messages" USING btree ("session_id","line_number");--> statement-breakpoint
CREATE INDEX "messages_session_agent_idx" ON "messages" USING btree ("session_id","agent_id");--> statement-breakpoint
CREATE INDEX "messages_agent_id_idx" ON "messages" USING btree ("agent_id") WHERE "messages"."is_subagent";--> statement-breakpoint
CREATE INDEX "messages_tool_use_id_idx" ON "messages" USING btree ("tool_use_id");--> statement-breakpoint
CREATE INDEX "subagents_session_id_idx" ON "subagents" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "subagents_parent_agent_id_idx" ON "subagents" USING btree ("parent_agent_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER sessions_set_updated_at BEFORE UPDATE ON "sessions"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER subagents_set_updated_at BEFORE UPDATE ON "subagents"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();