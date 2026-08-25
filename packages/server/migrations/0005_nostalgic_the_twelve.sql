CREATE TABLE "artifact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sessionId" text NOT NULL,
	"path" text NOT NULL,
	"relativePath" text NOT NULL,
	"mimeType" text NOT NULL,
	"isBinary" boolean NOT NULL,
	"baseContent" "bytea",
	"baseHash" text,
	"currentContent" "bytea" NOT NULL,
	"currentHash" text NOT NULL,
	"diff" text,
	"oldFragment" text,
	"changeKind" text NOT NULL,
	"editCount" integer DEFAULT 1 NOT NULL,
	"firstSeenAt" timestamp with time zone DEFAULT now() NOT NULL,
	"lastSeenAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifact_session_path_uniq" UNIQUE("sessionId","path"),
	CONSTRAINT "artifact_changeKind_check" CHECK ("artifact"."changeKind" in ('created', 'edited', 'editedUnknownBase'))
);
--> statement-breakpoint
ALTER TABLE "artifact" ADD CONSTRAINT "artifact_sessionId_sessions_id_fk" FOREIGN KEY ("sessionId") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifact_session_idx" ON "artifact" USING btree ("sessionId");--> statement-breakpoint
CREATE INDEX "artifact_relpath_idx" ON "artifact" USING btree ("relativePath");