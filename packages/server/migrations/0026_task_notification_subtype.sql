-- Repairs rows an older CLI stored before the server started correcting arriving messages: a
-- queued-command task notification whose subType was never set. `subType is null` is what makes
-- replaying this harmless -- rows already repaired no longer match.
update messages
set "subType" = 'taskNotification'
where "subType" is null
  and raw->>'type' = 'attachment'
  and raw->'attachment'->>'type' = 'queued_command'
  and raw->'attachment'->>'commandMode' = 'task-notification';
