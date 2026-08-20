CREATE OR REPLACE FUNCTION search_norm_v1(t text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(t,'') || ' ' || regexp_replace(coalesce(t,''), '[/._\\]+', ' ', 'g')
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION msg_search_text_v1(content jsonb, details jsonb, "msgType" text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT left(
    coalesce(content->>'value','') || ' ' ||
    CASE "msgType"
      WHEN 'toolCall' THEN coalesce(details->>'name','') || ' ' ||
        coalesce(jsonb_path_query_array(details->'input',
                 '$.**?(@.type() == "string")')::text, '')
      WHEN 'hookCall' THEN coalesce(details->>'command','')
      WHEN 'localCommand' THEN coalesce(details->>'command','')
      ELSE ''
    END,
    200000)
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION msg_search_tsv_v1(content jsonb, details jsonb, "msgType" text) RETURNS tsvector
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT to_tsvector('english',
         search_norm_v1(msg_search_text_v1(content, details, "msgType")))
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION session_search_tsv_v1(title text, cwd text) RETURNS tsvector
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT to_tsvector('english',
         search_norm_v1(coalesce(title,'') || ' ' || coalesce(cwd,'')))
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION search_query_v1(q text) RETURNS tsquery
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT websearch_to_tsquery('english',
         regexp_replace(coalesce(q,''), '[/._\\]+', ' ', 'g'))
$$;
