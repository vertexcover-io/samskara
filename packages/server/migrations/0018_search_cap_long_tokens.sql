CREATE OR REPLACE FUNCTION public.samskara_search_cap(value text) RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  WITH pruned AS (
    -- The parser discards every token over 2047 characters and logs a NOTICE for each one, so
    -- they are removed first and never count against the cap. POSIX limits a repetition count
    -- to 255, hence the chained runs.
    SELECT regexp_replace(value, '([^[:space:]]{255}){8}[^[:space:]]*', '', 'g') AS text
  ), capped AS (
    SELECT left(text, 32768) AS text, char_length(text) > 32768 AS truncated FROM pruned
  )
  SELECT CASE
    WHEN NOT truncated THEN text
    WHEN text ~ '[[:space:]]$' THEN text
    ELSE regexp_replace(text, '[^[:space:]]+$', '')
  END
  FROM capped
$$;
