ALTER TABLE "sessions" ADD COLUMN "startedAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "lastMessageAt" timestamp with time zone;--> statement-breakpoint
-- Every updatedAt trigger already executes set_updatedAt_camel(), and triggers bind to the
-- function's OID: renaming it re-homes all six, and only the body below changes.
ALTER FUNCTION set_updatedAt_camel() RENAME TO touch_updated_at;--> statement-breakpoint
-- Columns named as trigger arguments do not count as a change: an update that touches only those,
-- and nothing else, leaves "updatedAt" alone. With no arguments it always advances. Generated
-- columns are ignored as well: a BEFORE trigger runs before Postgres computes them, so NEW always
-- differs from OLD there, and they can never be the only change anyway.
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
DECLARE ignored text[];
BEGIN
  IF TG_NARGS > 0 THEN
    SELECT TG_ARGV || coalesce(array_agg(attname::text), '{}') INTO ignored
    FROM pg_attribute WHERE attrelid = TG_RELID AND attgenerated <> '' AND NOT attisdropped;
    IF to_jsonb(NEW) - ignored = to_jsonb(OLD) - ignored THEN RETURN NEW; END IF;
  END IF;
  NEW."updatedAt" = now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS sessions_set_updated_at ON "sessions";--> statement-breakpoint
CREATE TRIGGER sessions_set_updated_at BEFORE UPDATE ON "sessions"
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at('startedAt', 'lastMessageAt');--> statement-breakpoint
CREATE OR REPLACE FUNCTION touch_session_activity() RETURNS trigger AS $$
BEGIN
  UPDATE "sessions" s
  SET "startedAt"     = least(s."startedAt", agg.min_ts),
      "lastMessageAt" = greatest(s."lastMessageAt", agg.max_ts)
  FROM (SELECT "sessionId", min("timestamp") AS min_ts, max("timestamp") AS max_ts
        FROM inserted WHERE "timestamp" IS NOT NULL GROUP BY "sessionId") agg
  WHERE s.id = agg."sessionId"
    -- Only when the batch widens the window: a no-op UPDATE still writes a new row version.
    AND (s."startedAt" IS NULL OR agg.min_ts < s."startedAt"
         OR s."lastMessageAt" IS NULL OR agg.max_ts > s."lastMessageAt");
  RETURN NULL;
END $$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER messages_touch_session AFTER INSERT ON "messages"
  REFERENCING NEW TABLE AS inserted FOR EACH STATEMENT
  EXECUTE FUNCTION touch_session_activity();--> statement-breakpoint
UPDATE "sessions" s SET "startedAt" = agg.min_ts, "lastMessageAt" = agg.max_ts
FROM (SELECT "sessionId", min("timestamp") AS min_ts, max("timestamp") AS max_ts
      FROM "messages" WHERE "timestamp" IS NOT NULL GROUP BY "sessionId") agg
WHERE agg."sessionId" = s.id;--> statement-breakpoint
CREATE INDEX "sessions_activity_idx" ON "sessions" USING btree ((coalesce("lastMessageAt", "updatedAt")) desc,"id");
