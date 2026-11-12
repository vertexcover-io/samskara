-- Under the old rule a redo kept the previous result on its row while it waited, ran or
-- failed. Each run is its own row now and only a done row shows, so the result stays on the
-- original row (its problems point at it) and the redo's state moves to a new row created just
-- after it. A running redo goes back to waiting: the worker that held it is gone after a deploy.
-- The redo's state is copied aside first: inserting it while the original is still waiting or
-- running would break the one-active-run index.
create temp table "carriedRedos" as
select "sessionId", "projectId", "analyzer",
  case when "status" = 'running' then 'waiting' else "status" end as "status",
  "attempts", "error", "harness", "model", "prompt", "updatedAt"
from "sessionReviews"
where "outcome" is not null and "status" <> 'done';
--> statement-breakpoint
update "sessionReviews" set "status" = 'done', "error" = null
where "outcome" is not null and "status" <> 'done';
--> statement-breakpoint
insert into "sessionReviews" ("sessionId", "projectId", "analyzer", "status", "attempts",
  "error", "harness", "model", "prompt", "createdAt", "updatedAt")
select "sessionId", "projectId", "analyzer", "status", "attempts", "error", "harness", "model",
  "prompt", "updatedAt", "updatedAt"
from "carriedRedos";
--> statement-breakpoint
drop table "carriedRedos";
--> statement-breakpoint
-- reviewedThrough was a main-conversation line. New messages are found by time, so the link is
-- the latest timed main message at or before it: a transcript often ends on an untimed cost line,
-- and linking to that would make every message new. A session with no timed message keeps the
-- line's last message.
update "sessionReviews" sr
set "lastMessageId" = coalesce(
  (select m."id" from "messages" m
    where m."sessionId" = sr."sessionId"
      and m."trackId" = 'main'
      and m."lineNumber" <= sr."reviewedThrough"
      and m."timestamp" is not null
    order by m."timestamp" desc, m."lineNumber" desc, m."subIndex" desc
    limit 1),
  (select m."id" from "messages" m
    where m."sessionId" = sr."sessionId"
      and m."trackId" = 'main'
      and m."lineNumber" = sr."reviewedThrough"
    order by m."subIndex" desc
    limit 1)
)
where sr."reviewedThrough" is not null and sr."lastMessageId" is null;
