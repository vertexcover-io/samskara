CREATE TABLE "userCliVersion" (
	"userId" uuid NOT NULL,
	"projectId" uuid NOT NULL,
	"cliVersion" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "userCliVersion_userId_projectId_cliVersion_pk" PRIMARY KEY("userId","projectId","cliVersion")
);
--> statement-breakpoint
ALTER TABLE "userCliVersion" ADD CONSTRAINT "userCliVersion_userId_users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "userCliVersion" ADD CONSTRAINT "userCliVersion_projectId_projects_id_fk" FOREIGN KEY ("projectId") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "userCliVersion_user_updated_idx" ON "userCliVersion" USING btree ("userId","updatedAt");--> statement-breakpoint
CREATE INDEX "projects_owner_user_idx" ON "projects" USING btree ("ownerId");