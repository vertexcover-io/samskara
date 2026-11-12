CREATE TABLE "reviewReaderReplies" (
	"reviewId" uuid NOT NULL,
	"pieceHash" text NOT NULL,
	"reply" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reviewReaderReplies_reviewId_pieceHash_pk" PRIMARY KEY("reviewId","pieceHash")
);
--> statement-breakpoint
ALTER TABLE "reviewReaderReplies" ADD CONSTRAINT "reviewReaderReplies_reviewId_sessionReviews_id_fk" FOREIGN KEY ("reviewId") REFERENCES "public"."sessionReviews"("id") ON DELETE cascade ON UPDATE no action;