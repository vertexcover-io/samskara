import type { Artifact } from "./records.js"

const MARKDOWN = `# Idempotent ingest

Rescans were duplicating rows because ingest had **no natural key**. This note
records the fix and the reasoning behind it.

## Why duplicates appeared

Every rescan re-inserted the same transcript lines. Three tables were affected:

| Table        | Rows before | Rows after | Natural key            |
| ------------ | ----------- | ---------- | ---------------------- |
| \`sessions\`   | 4,182       | 1,984      | \`sourceUid\`            |
| \`messages\`   | 61,004      | 20,334     | \`sessionId + lineNo\`   |
| \`toolCall\`   | 1,107       | 369        | \`toolId\`               |

## The fix

Add a unique constraint, then switch inserts to upserts:

\`\`\`sql
ALTER TABLE messages
  ADD CONSTRAINT messages_session_line_uniq
  UNIQUE ("sessionId", "lineNumber");
\`\`\`

The repository layer then becomes an upsert rather than a blind insert:

\`\`\`ts
await db
  .insert(messages)
  .values(rows)
  .onConflictDoUpdate({
    target: [messages.sessionId, messages.lineNumber],
    set: { content: sql\`excluded.content\` },
  })
\`\`\`

> Reprocessing the same transcript twice must be a no-op. That is the whole
> contract — everything else follows from it.

### Checklist

- [x] Unique constraints on all three tables
- [x] Inserts converted to upserts
- [ ] Backfill dedupe for existing rows
`

const MERMAID = `# Ingest pipeline

The watcher tails a transcript and hands each batch to the ingest service.

## Flow

\`\`\`mermaid
flowchart TD
  A[Transcript file] -->|tail| B(Watcher)
  B --> C{New lines?}
  C -->|no| B
  C -->|yes| D[Normalize]
  D --> E[Upsert messages]
  E --> F[Upsert tool calls]
  F --> G[(Postgres)]
  G --> H[Session detail API]
\`\`\`

## Ordering guarantees

Watermarks make a resumed read pick up exactly where it stopped.

\`\`\`mermaid
sequenceDiagram
  participant W as Watcher
  participant I as Ingest
  participant DB as Postgres
  W->>I: batch(lines 1..40)
  I->>DB: upsert 40 rows
  DB-->>I: ok
  I-->>W: watermark = 40
  W->>I: batch(lines 41..99)
  I->>DB: upsert 59 rows
  DB-->>I: ok
  I-->>W: watermark = 99
\`\`\`
`

const SOURCE = `import { and, eq } from "drizzle-orm"
import type { Querier } from "../db/client.js"
import { toolCall, toolResult } from "../db/schema.js"

type ToolProjection = {
  readonly call?: { readonly callId: string; readonly name: string; readonly input: unknown }
  readonly result?: { readonly callId: string; readonly output: unknown }
}

// A call and its result arrive as separate messages, so they are keyed by
// toolId alone -- joining on messageId as well would never match.
export const replaceForMessage = async (
  db: Querier,
  messageId: string,
  tool: ToolProjection,
): Promise<void> => {
  await db.delete(toolCall).where(eq(toolCall.messageId, messageId))

  if (tool.call) {
    await db.insert(toolCall).values({
      toolId: tool.call.callId,
      messageId,
      toolName: tool.call.name,
      toolInput: tool.call.input,
    })
  }
}
`

const DIFF = `--- a/packages/server/src/repositories/sessions.repo.ts
+++ b/packages/server/src/repositories/sessions.repo.ts
@@ -289,10 +289,7 @@ export const detailFor = async (
       .from(toolCall)
       .innerJoin(messages, eq(messages.id, toolCall.messageId))
-      .leftJoin(
-        toolResult,
-        and(eq(toolResult.toolId, toolCall.toolId), eq(toolResult.messageId, toolCall.messageId)),
-      )
+      .leftJoin(toolResult, eq(toolResult.toolId, toolCall.toolId))
       .where(eq(messages.sessionId, sessionId))
`

const PIXEL =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0ODAiIGhlaWdodD0iMjcwIiB2aWV3Qm94PSIwIDAgNDgwIDI3MCI+PHJlY3Qgd2lkdGg9IjQ4MCIgaGVpZ2h0PSIyNzAiIGZpbGw9IiNlOWViZWYiLz48ZyBmaWxsPSJub25lIiBzdHJva2U9IiMyYjRhNzgiIHN0cm9rZS13aWR0aD0iMiI+PHJlY3QgeD0iNDAiIHk9IjQ4IiB3aWR0aD0iMTIwIiBoZWlnaHQ9IjYwIiByeD0iNCIvPjxyZWN0IHg9IjMyMCIgeT0iNDgiIHdpZHRoPSIxMjAiIGhlaWdodD0iNjAiIHJ4PSI0Ii8+PHJlY3QgeD0iMTgwIiB5PSIxNjIiIHdpZHRoPSIxMjAiIGhlaWdodD0iNjAiIHJ4PSI0Ii8+PHBhdGggZD0iTTE2MCA3OGgxNjBNMjQwIDEwOHY1NCIvPjwvZz48ZyBmb250LWZhbWlseT0ibW9ub3NwYWNlIiBmb250LXNpemU9IjEzIiBmaWxsPSIjMWExYzIwIj48dGV4dCB4PSI2NCIgeT0iODMiPndhdGNoZXI8L3RleHQ+PHRleHQgeD0iMzQ4IiB5PSI4MyI+aW5nZXN0PC90ZXh0Pjx0ZXh0IHg9IjIxNiIgeT0iMTk3Ij5wZ3NxbDwvdGV4dD48L2c+PC9zdmc+"

const at = (minute: number): string => new Date(Date.UTC(2026, 6, 26, 4, minute, 0)).toISOString()

export const DEMO_ARTIFACTS: ReadonlyArray<Artifact> = [
  {
    id: "demo-md",
    path: "docs/idempotent-ingest.md",
    url: null,
    title: "Idempotent ingest",
    timestamp: at(24),
    content: MARKDOWN,
    mimeType: "text/markdown",
    agent: null,
    access: "granted",
  },
  {
    id: "demo-mermaid",
    path: "docs/ingest-pipeline.md",
    url: null,
    title: "Ingest pipeline diagrams",
    timestamp: at(31),
    content: MERMAID,
    mimeType: "text/markdown",
    agent: "db-schema-auditor",
    access: "granted",
  },
  {
    id: "demo-source",
    path: "packages/server/src/repositories/toolRows.repo.ts",
    url: null,
    title: "Tool row repository",
    timestamp: at(38),
    content: SOURCE,
    mimeType: "text/x-typescript",
    agent: null,
    access: "granted",
  },
  {
    id: "demo-diff",
    path: "patches/tool-result-join.diff",
    url: null,
    title: "Tool result join fix",
    timestamp: at(42),
    content: DIFF,
    mimeType: "text/x-diff",
    agent: null,
    access: "granted",
  },
  {
    id: "demo-image",
    path: "docs/architecture.svg",
    url: PIXEL,
    title: "Capture architecture",
    timestamp: at(47),
    content: null,
    mimeType: "image/svg+xml",
    agent: null,
    access: "granted",
  },
  {
    id: "demo-video",
    path: "docs/walkthrough.mp4",
    url: null,
    title: "Session walkthrough",
    timestamp: at(51),
    content: null,
    mimeType: "video/mp4",
    agent: "test-writer",
    access: "granted",
  },
  {
    id: "demo-denied",
    path: ".env.production",
    url: null,
    title: null,
    timestamp: at(55),
    content: null,
    mimeType: "text/plain",
    agent: null,
    access: "denied",
  },
  {
    id: "demo-missing",
    path: null,
    url: null,
    title: null,
    timestamp: null,
    content: null,
    mimeType: null,
    agent: null,
    access: "granted",
  },
]
