ALTER TABLE "artifact" DROP COLUMN "baseHash";--> statement-breakpoint
ALTER TABLE "artifact" DROP COLUMN "oldFragment";--> statement-breakpoint
-- Hand-added: the migration that created "edits" was withdrawn before it shipped, so a database
-- that already applied it keeps an orphan column that no fresh database ever gets. IF EXISTS makes
-- this a no-op on the fresh ones.
ALTER TABLE "artifact" DROP COLUMN IF EXISTS "edits";
