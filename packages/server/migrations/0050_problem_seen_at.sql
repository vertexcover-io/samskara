ALTER TABLE "reviewProblems" ADD COLUMN "seenAt" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
-- Problems saved before seenAt existed: the time of the earliest message their evidence cites.
-- Evidence names messages as msg-N, the Nth entry of the review's signals.run.recordIds; a review
-- saved before that order was kept, or a cited message that is gone or has no time, leaves the
-- problem at when it was saved.
UPDATE "reviewProblems" p SET "seenAt" = coalesce((
  SELECT min(m."timestamp")
  FROM jsonb_array_elements(
    CASE WHEN jsonb_typeof(p."evidence") = 'array' THEN p."evidence" ELSE '[]'::jsonb END
  ) AS e(item)
  JOIN "sessionReviews" r ON r."id" = p."reviewId"
    AND jsonb_typeof(r."signals" -> 'run' -> 'recordIds') = 'array'
  JOIN "messages" m ON m."sessionId" = p."sessionId"
    AND m."id"::text = r."signals" -> 'run' -> 'recordIds' ->> (substring(e.item ->> 'from' from '^msg-(\d+)$')::int)
  WHERE e.item ->> 'from' ~ '^msg-\d+$'
), p."createdAt");
