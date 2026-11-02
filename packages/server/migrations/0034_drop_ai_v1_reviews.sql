-- The old lens reviewer (ai-v1) is gone: nothing writes these rows any more, and nothing reads
-- them. Data only. The AI review (ai-problems-v2) and the static review (heuristic-v1) stay.
DELETE FROM "sessionReviews" WHERE "analyzer" = 'ai-v1';
