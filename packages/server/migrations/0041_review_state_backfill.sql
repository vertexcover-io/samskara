-- Records how far each review saved before review state existed had read: the last
-- main-conversation line its session had stored by the time the review was saved. Subagent
-- transcripts number their own lines from 1, so only the main track's numbers compare. Only
-- done rows have read anything, and `reviewedThrough is null` makes replaying this harmless --
-- a row already filled no longer matches, and one whose session had no messages computes null
-- again.
update "sessionReviews" sr
set "reviewedThrough" = (
  select max(m."lineNumber") from "messages" m
  where m."sessionId" = sr."sessionId"
    and m."trackId" = 'main'
    and m."createdAt" <= sr."updatedAt"
)
where sr."reviewedThrough" is null
  and sr."status" = 'done';
