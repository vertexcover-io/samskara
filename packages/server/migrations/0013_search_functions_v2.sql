CREATE OR REPLACE FUNCTION msg_search_text_v2(content jsonb, details jsonb, "msgType" text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT left(
    coalesce(content->>'value','') || ' ' ||
    CASE "msgType"
      WHEN 'toolCall' THEN coalesce(details->>'name','') || ' ' ||
        coalesce(jsonb_path_query_array(details->'input',
                 '$.**?(@.type() == "string")')::text, '')
      WHEN 'hookCall' THEN coalesce(details->>'command','')
      WHEN 'localCommand' THEN coalesce(details->>'command','') || ' ' || coalesce(details->>'args','')
      ELSE ''
    END,
    200000)
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION msg_search_tsv_v2(content jsonb, details jsonb, "msgType" text) RETURNS tsvector
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT to_tsvector('english',
         search_norm_v1(msg_search_text_v2(content, details, "msgType")))
$$;
