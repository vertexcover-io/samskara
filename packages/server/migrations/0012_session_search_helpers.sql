CREATE OR REPLACE FUNCTION public.samskara_search_json_text(value jsonb) RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT CASE jsonb_typeof(value)
    WHEN 'string' THEN value #>> '{}'
    WHEN 'number' THEN value #>> '{}'
    WHEN 'array' THEN coalesce((
      SELECT string_agg(item_text, E'\n' ORDER BY ordinal)
      FROM jsonb_array_elements(value) WITH ORDINALITY AS elements(item, ordinal)
      CROSS JOIN LATERAL (SELECT public.samskara_search_json_text(item) AS item_text) AS extracted
      WHERE item_text <> ''
    ), '')
    WHEN 'object' THEN coalesce((
      SELECT string_agg(item_text, E'\n' ORDER BY key COLLATE "C")
      FROM jsonb_each(value) AS elements(key, item)
      CROSS JOIN LATERAL (SELECT public.samskara_search_json_text(item) AS item_text) AS extracted
      WHERE item_text <> ''
    ), '')
    ELSE ''
  END
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.samskara_search_cap(value text) RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  WITH capped AS (
    SELECT left(value, 32768) AS text, char_length(value) > 32768 AS truncated
  )
  SELECT CASE
    WHEN NOT truncated THEN text
    WHEN text ~ '[[:space:]]$' THEN text
    ELSE regexp_replace(text, '[^[:space:]]+$', '')
  END
  FROM capped
$$;
