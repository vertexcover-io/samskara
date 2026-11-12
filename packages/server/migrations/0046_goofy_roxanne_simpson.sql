ALTER TABLE "sessionReviews" DROP CONSTRAINT "sessionReviews_session_analyzer_unique";--> statement-breakpoint
ALTER TABLE "sessionReviews" ADD COLUMN "newPartOnly" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sessionReviews" ADD COLUMN "basedOn" uuid;--> statement-breakpoint
ALTER TABLE "sessionReviews" ADD COLUMN "lastMessageId" uuid;--> statement-breakpoint
ALTER TABLE "sessionReviews" ADD CONSTRAINT "sessionReviews_basedOn_sessionReviews_id_fk" FOREIGN KEY ("basedOn") REFERENCES "public"."sessionReviews"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessionReviews" ADD CONSTRAINT "sessionReviews_lastMessageId_messages_id_fk" FOREIGN KEY ("lastMessageId") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sessionReviews_one_active_per_session" ON "sessionReviews" USING btree ("sessionId","analyzer") WHERE "sessionReviews"."status" in ('waiting', 'running');--> statement-breakpoint
CREATE INDEX "sessionReviews_session_analyzer_createdAt_idx" ON "sessionReviews" USING btree ("sessionId","analyzer","createdAt");