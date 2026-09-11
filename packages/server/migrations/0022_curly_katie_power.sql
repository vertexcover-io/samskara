ALTER TABLE "sessions" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN "searchVector";--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "searchVector" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, public.samskara_search_cap(((((((coalesce("sessions"."name", '') || ' ') || coalesce("sessions"."description", '')) || ' ') || coalesce("sessions"."title", '')) || ' ') || "sessions"."id")))) STORED;--> statement-breakpoint
DROP TRIGGER IF EXISTS sessions_set_updated_at ON "sessions";--> statement-breakpoint
CREATE TRIGGER sessions_set_updated_at BEFORE UPDATE ON "sessions"
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at('startedAt', 'lastMessageAt', 'name', 'description');
