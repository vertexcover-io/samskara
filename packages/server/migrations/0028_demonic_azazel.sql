ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "tags" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
DROP TRIGGER IF EXISTS sessions_set_updated_at ON "sessions";--> statement-breakpoint
CREATE TRIGGER sessions_set_updated_at BEFORE UPDATE ON "sessions"
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at('startedAt', 'lastMessageAt', 'name', 'description', 'tags');
