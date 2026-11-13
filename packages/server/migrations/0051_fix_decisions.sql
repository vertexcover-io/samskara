ALTER TABLE "learnings" DROP CONSTRAINT "learnings_skippedBy_users_id_fk";
--> statement-breakpoint
ALTER TABLE "learnings" ADD COLUMN "decision" text DEFAULT 'open' NOT NULL;--> statement-breakpoint
ALTER TABLE "learnings" ADD COLUMN "decidedAt" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "learnings" ADD COLUMN "decidedBy" uuid;--> statement-breakpoint
ALTER TABLE "learnings" ADD COLUMN "rejectReason" text;--> statement-breakpoint
ALTER TABLE "learnings" ADD COLUMN "skipCount" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "learnings" ADD COLUMN "sessionsAtSkip" integer;--> statement-breakpoint
ALTER TABLE "learnings" ADD CONSTRAINT "learnings_decidedBy_users_id_fk" FOREIGN KEY ("decidedBy") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- A fix skipped before decisions existed becomes a skipped decision: the same person and
-- time, and its first skip. The session count at that skip was never recorded, so it takes
-- the count now, the one the Fixes card shows (distinct sessions behind its problems that
-- are still in the fix's project); it comes back after 10 more sessions from here.
-- The decision = 'open' guard makes a replay change nothing.
update "learnings" l set
  "decision" = 'skipped',
  "decidedAt" = l."skippedAt",
  "decidedBy" = l."skippedBy",
  "skipCount" = 1,
  "sessionsAtSkip" = (
    select count(distinct s."id")::int from "reviewProblems" rp
    join "sessions" s on s."id" = rp."sessionId" and s."projectId" = l."projectId"
    where rp."learningId" = l."id"
  )
where l."skippedAt" is not null and l."decision" = 'open';--> statement-breakpoint
ALTER TABLE "learnings" DROP COLUMN "skippedAt";--> statement-breakpoint
ALTER TABLE "learnings" DROP COLUMN "skippedBy";--> statement-breakpoint
ALTER TABLE "learnings" ADD CONSTRAINT "learnings_decision_check" CHECK ("learnings"."decision" in ('open', 'accepted', 'skipped', 'rejected'));--> statement-breakpoint
ALTER TABLE "learnings" ADD CONSTRAINT "learnings_rejectReason_check" CHECK (("learnings"."decision" = 'rejected') = ("learnings"."rejectReason" is not null));