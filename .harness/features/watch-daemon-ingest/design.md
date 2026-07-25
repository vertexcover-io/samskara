# Design: Watch Daemon + Ingest + Data Model (2b)

> One consolidated design for samskara's capture pipeline: the client watcher that discovers
> and parses Claude session files, the ingest contract, the server upsert + reconciliation, the
> sessions/messages/tool/subagents schema, and the `SourceAdapter` interface. Builds on the 2a
> identity mesh and the auth system (`aud:cli` JWT). Discovery mechanism borrows from opentrace;
> the sync/parse/store design is our own.

## Problem

An always-on daemon must reliably capture Claude Code sessions (main + subagents) from local
`~/.claude/projects/**/*.jsonl` into Postgres — line-wise, idempotent, crash-safe, subagents
first-class — while keeping local filesystem state out of the server and allowing the parse
logic to be fixed server-side without re-reading client files.

## Non-Goals (deferred)

- Redaction *implementation* (the seam exists — client ships redacted raw — but the redaction
  pass itself is a later milestone; initially a no-op).
- Summarization, learnings, embeddings/search, MCP, blob/artifacts, pricing/cost.
- **Workflows** (`workflows/<runId>.json`, `subagents/workflows/`, `journal.jsonl`) — own
  milestone with its own first-class `workflows` table.
- Multi-tool adapters beyond Claude (the interface + registry are built generic; only the
  `claude_code` adapter is implemented).

## Naming convention (load-bearing)

**camelCase everywhere** — TS variables/functions, type fields, JSON API payload fields (the
ingest contract is camelCase on the wire), config keys, Drizzle JS properties, **AND the
Postgres column names themselves** (`text("sessionId")`; drizzle-kit emits quoted identifiers,
so `"sessionId"` survives Postgres's lowercase-folding). No snake_case seam anywhere — column
name == TS property == wire field, 1:1. The ONLY snake_case permitted: verbatim keys of stored
external raw data (Claude's own JSONL keys inside the `raw` JSONB are untouched). Never
introduce a snake_case identifier in our schema, payloads, types, or config. (Divergence from
opentrace, which is snake_case because it's Python; we are TS end-to-end.) Consequence:
hand-written SQL / `psql` must double-quote column refs (`SELECT "sessionId" ...`) — fine since
we are Drizzle-first (query builder + drizzle-kit); hand-appended migration SQL (triggers) must
quote column names.

## Plugin architecture (`packages/core/src/collector/`)

**Framework provides composable helpers; each plugin owns its read+parse and calls the helpers
it needs.** The only stable identifier is `source`. Resume/parse are behaviors plugins compose,
not categories the framework switches on. Adding a new agent later = a new plugin module with
**zero edits to shared code**. Build Claude helpers only now; keep the seams.

### Plugin contract

```ts
interface AgentPlugin {
  source: string;                 // unique id, e.g. "claude_code"
  globs: string[];                // e.g. ["~/.claude/projects/**/*.jsonl"]
  collect(changed: ChangedFile, prev: FileState | null): CollectResult;
}
// plugins self-register: register(plugin). Framework iterates the registry, never names an agent.
```

### Core types

```ts
interface ChangedFile { path: string; source: string; mtime: number; size: number; }

interface CollectResult {
  messages: NormalizedMessage[];    // fully parsed (not raw lines)
  subagents?: SubagentInfo[];       // from .meta.json sidecar; Claude subagent files only
  newState: FileState;              // advanced cursor — returned even when messages is empty
}

interface SubagentInfo {
  agentId: string;                  // == filename, == messages' agentId
  agentType?: string;               // from .meta.json ("Explore" | "fork" | ...)
  description?: string;
  spawnDepth?: number;
  spawnToolUseId?: string;
  sourceRelativePath: string;
}
```

### FileState — base + per-source cursor union

```ts
interface FileStateBase {
  filePath: string; source: string;
  sessionId: string | null;           // the session this file belongs to
  type: "main" | "subagent";          // discriminator (same as ingest payload `type`); drives main-before-subagent ordering
  agentId: string | null;             // set when type === "subagent"
  retryCount: number; lastError: string | null;
  lastMtime: number; lastSize: number;
}
interface LineCursor { kind: "line"; lastLineProcessed: number; }  // `kind` here = CURSOR kind, distinct from fileType
type ResumeCursor = LineCursor; // | HashCursor | TimestampMapCursor  (future)
type FileState = FileStateBase & { cursor: ResumeCursor };
// persisted as JSON via atomic temp-write + rename; ~/.samskara/state.json (camelCase keys)
```

### Helpers (Claude only for now)

```ts
// Line-offset resume for append-only JSONL; early-exit when size unchanged.
function readNewLines(path, prev): { lines: Array<{lineNumber:number; text:string}>; cursor: LineCursor };
// Parse JSONL text → objects, skipping blank/malformed lines.
function iterJsonLines(lines): Array<{lineNumber:number; data:unknown}>;
// cwd → repo/git resolution (identity chain: local git config). Result travels ONCE per flush
// envelope, NOT stamped on every message.
function resolveSessionContext(cwd, gitBranch, identity): SessionContext;
// Claude-only: given a subagent transcript path, read + parse its sibling .meta.json.
function readClaudeSidecar(transcriptPath): SubagentInfo | null;
// (Add readIfHashChanged / changedSessionsByTimestamp only when a source needs them.)
```

### Claude plugin (reference — ~3 lines of read)

```ts
function collect(changed: ChangedFile, prev: FileState | null): CollectResult {
  const { lines, cursor } = readNewLines(changed.path, prev);
  const records = iterJsonLines(lines);
  const messages = records.flatMap(({ lineNumber, data }) => normalizeClaude(data, lineNumber));
  const isSubagent = /\/subagents\/agent-[a-f0-9]+\.jsonl$/.test(changed.path);
  const subagents = isSubagent ? compact([readClaudeSidecar(changed.path)]) : undefined;
  return { messages, subagents, newState: { ...base(changed), cursor } };
}
// normalizeClaude: assistant line → assistant + toolCall + toolResult messages (fan-out);
// metadata-only lines → []. Tokens: input_tokens→input, output_tokens→output,
// cache_read_input_tokens→cached, thinking=0. (snake_case here = Claude's raw keys.)
```

### NormalizedMessage (unified target)

```ts
type MsgType = "user"|"assistant"|"system"|"toolCall"|"toolResult"    // conversation
             | "progress"|"systemEvent"|"queueOperation"|"fileSnapshot"|"summary"; // observability

// What the plugin's collect() returns AND what travels on the wire (per message).
// agentId is carried on EVERY message (self-describing; duplicated across a flush's messages
// by design — trivial cost, no envelope lookup to stamp it). Line-level raw is NOT per message:
// it travels once per line in rawLines (keyed by lineUuid).
interface NormalizedMessage {
  lineUuid: string; subIndex: number;              // fan-out identity → UNIQUE(lineUuid, subIndex)
  sessionId: string; source: string; sourceSchemaVersion: number;
  msgType: MsgType; timestamp: string; lineNumber: number;
  content?: string;
  tokens: { input: number; output: number; cached: number; thinking: number };
  toolCall?: { id: string; name: string; input: unknown };     // server derives toolCall TABLE from this
  toolResult?: { callId: string; output: string; status: "success"|"failure" }; // → toolResult TABLE
  thinking?: string; model?: string;
  agentId?: string;                                // subagent transcripts; null on main-session messages
}
// Envelope-level (NOT on each message): type ("main"|"subagent"), the subagent's meta (agent{}).
// Line-level (in rawLines, keyed by lineUuid): raw (redacted source line, re-derivation truth).
```

**Reconciliation notes:** (1) `toolCall`/`toolResult` are message *fields* (client), and the
**server derives the `toolCall`/`toolResult` TABLES** from them (delete-and-replace per
message, no agentId). (2) `sessionContext` is resolved client-side but sent **once per flush
envelope**, not per message. (3) The redacted source line travels **once per line** in
`rawLines` (keyed by `lineUuid`), not per fanned-out message — it enables server re-parse when
`sourceSchemaVersion` bumps. (4) Nested subagents' `parentAgentId` resolved **server-side**
(deferred), not in the plugin.

### Agent-agnostic driver

1. **Discover** — glob each plugin's patterns (cache globs, invalidate on parent-dir mtime) → `ChangedFile`.
2. **Collect** — load `prev` state, call `plugin.collect(changed, prev)`.
3. **Push** — serialize `messages` + `subagents` + envelope + redacted raw → POST /ingest.
4. **Persist** — write back `newState` (only on 2xx — W4).

## Key Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| W1 | Single detached daemon `samskara watch` (PID/lock) | One crawler for all projects; independent of any Claude session. |
| W2 | Discovery = **poll-glob** `~/.claude/projects/**/*.jsonl` (~10s), re-glob new (~30s), per-file line-watermark (opentrace mechanism) | Portable, no watch-descriptor limits; self-heals torn trailing lines. |
| W3 | **Client parses** (fan-out → messages + tool rows + subagent meta) via `parse()`; **redacts raw**; ships parsed records **+ redacted raw** | Immediate queryability + privacy preserved client-side + server can re-derive from raw. |
| W4 | **Per-file flush**; advance that file's watermark **only on 2xx** | Failure isolation kills the "advance over unlanded lines" data-loss bug; trivial retry. |
| W5 | **Line cap 2000 per flush**, loop until caught up | Bounds payload/memory; first-scan of a huge file never one unbounded request. |
| W6 | **Client orders sends**: main file before its subagent files (within & across cycles) | Server needs no defensive session stub. |
| W7 | **Resume client-local** (watermark on disk); server stateless about files | Server portable; no `fileProgress` table. |
| A1 | Line → **N messages, one per content block** (text, thinking, tool_use, tool_result), client-side fan-out | opentrace-faithful fan-out; tool blocks are real message rows. |
| A2 | `toolCall`/`toolResult` are **separate tables**, **server-derived** from the tool-typed messages, **no `agentId`** | Deriving tools from content = parsing → owned server-side; join `messageId → messages.agentId` when needed. |
| A3 | Ship **redacted raw** per source line alongside messages | Re-derivation source of truth; privacy: raw is redacted before it leaves the client. |
| A4 | `sourceSchemaVersion` (the adapter's) stamped per message | Server re-derives `WHERE "sourceSchemaVersion" < current` from stored raw. Targeted backfill. |
| I1 | Ingest idempotent: session → subagent (if any) → messages `ON CONFLICT (lineUuid, subIndex) DO NOTHING`; tool rows **delete-and-replace per message** | Safe under retry/replay/re-scan; self-correcting when parse improves. |
| I2 | **Reject 4xx** if a flush's session doesn't exist (client sends main first) | Watermark unadvanced → retried next cycle. No stub. |
| I3 | **Retry indefinitely, no special logging** for rejected flush | Simplicity over stuck-file observability (accepted). |
| I4 | **Deferred `parentAgentId` resolution** after ingest, session-scoped | Order-independent; late parents resolve on next flush. |
| I5 | **Subagent row created even without `.meta.json`**; upgraded when meta arrives (NOT rejected) | Required parent (session) rejects; optional label (meta) enriches. |
| S1 | **Drop rollup columns** (messageCount, first/lastEventAt); derive on read | No denormalized number to drift. |

## Schema

TIMESTAMPTZ; TEXT+CHECK over pg enums; shared `set_updated_at()` trigger where `updated_at`.

Column names are **camelCase** (Drizzle `text("sessionId")`; drizzle-kit emits quoted
identifiers). camelCase everywhere — TS, wire, AND DB columns — no snake_case seam.

```
sessions
  id                 text PK            -- Claude sessionId
  source, userId→users, repoId→repos
  model, provider (derived from model), title, cwd, gitBranch, gitCommit,
  cliVersion, permissionMode
  createdAt, updatedAt

messages
  id                 uuid PK (surrogate)
  UNIQUE(lineUuid, subIndex)            -- fan-out identity; dedupe key
  sessionId→sessions ON DELETE CASCADE
  lineUuid           text               -- source line's uuid
  subIndex           int                -- ordinal content-block within the line
  parentUuid         text
  msgType            text               -- text|thinking|toolCall|toolResult|... (one per block)
  role, timestamp, lineNumber
  model, provider
  content            text               -- the block's payload
  raw                jsonb              -- redacted raw of the SOURCE LINE (shared by siblings)
  sourceSchemaVersion int
  isSubagent         boolean DEFAULT false
  agentId            text               -- → subagents.agentId (subagent lines)
  createdAt
  INDEX(sessionId, lineNumber), INDEX(sessionId, agentId), INDEX(agentId) WHERE isSubagent

toolCall             -- server-derived; delete-and-replace per message
  toolId             text               -- toolu_...
  messageId          uuid → messages(id) ON DELETE CASCADE
  PRIMARY KEY (toolId, messageId)       -- composite identity; message link is part of the key
  toolName, toolInput jsonb             -- NO agentId
  INDEX(messageId)                      -- delete-by-message on re-derive
  INDEX(toolId)                         -- correlate to toolResult + parentAgentId resolution

toolResult           -- server-derived
  toolId             text               -- correlates to toolCall.toolId (indexed, NOT a hard FK: results may precede calls)
  messageId          uuid → messages(id) ON DELETE CASCADE
  PRIMARY KEY (toolId, messageId)
  result             text
  status             text               -- CHECK (success|failure); NO agentId
  INDEX(messageId)
  INDEX(toolId)

tokenUsage
  messageId→messages PK
  inputTokens, outputTokens, cachedTokens, thinkingTokens

subagents
  agentId            text
  sessionId→sessions
  PRIMARY KEY(sessionId, agentId)
  agentType, description, spawnDepth, spawnToolUseId   -- from .meta.json (nullable until meta seen)
  parentAgentId      text               -- resolved deferred; NULL at depth 1
  sourceRelativePath text
  createdAt, updatedAt
  INDEX(sessionId), INDEX(parentAgentId)
```

## Watcher loop (per cycle, ~10s)

```
re-glob if 30s elapsed or a tracked parent dir mtime changed
for each grown file (order: main files first, then subagent files):
   read new lines from watermark, up to 2000
   redact raw lines
   records = adapter.parse({ rawLines, file, sidecar? })   // messages + tool rows + subagent meta
   POST /ingest { file, repo, agent?, session?, messages[], rawLines[] }  Bearer <cli JWT>
   on 2xx: advance watermark (+loop if more lines)
   on 4xx/5xx: leave watermark; retry next cycle
persist watermarks (~/.samskara/state.json)
```

## Ingest contract (frozen)

`POST /api/ingest` · `Authorization: Bearer <aud:cli JWT>`

Unified discriminated-union payload (one shape, keyed on `type`). camelCase on the wire.
Flush-level facts live in the envelope (not repeated per message); line-level `raw` lives once
per line (not per fanned-out message); optional/absent fields are omitted (no nulls).

```jsonc
{
  "sessionId": "f4101b9e",                       // always present
  "type": "subagent",                            // "main" | "subagent"  (discriminator)
  "sourceRelativePath": "subagents/agent-af66.jsonl",   // this flush's file
  "repo": { "host":"github","owner":"refrens","ownerType":"org","repoName":"andromeda" },

  // present only when type === "subagent":
  "agent": { "agentId":"af66","agentType":"Explore","description":"...","spawnDepth":1,"spawnToolUseId":"toolu_..." },

  // present only when type === "main":
  // "session": { "model":"claude-opus-4-8","title":"...","cwd":"...","gitBranch":"main","gitCommit":"...","cliVersion":"2.1.217","permissionMode":"..." },

  "rawLines": [ { "lineUuid":"beb2...", "raw":"<redacted raw source line>" } ],   // once per line
  "messages": [
    { "lineUuid":"beb2...","subIndex":0,"msgType":"assistant","timestamp":"...Z",
      "lineNumber":42,"model":"claude-opus-4-8","content":"...","sourceSchemaVersion":1,
      "tokens":{"input":120,"output":40,"cached":0,"thinking":0},"agentId":"af66" }
      // toolCall / toolResult present ONLY when this block is one; omitted otherwise
      // agentId on every subagent message (self-describing); omitted/null on main-session messages
  ]
}
```
- `type` discriminates: `agent` present iff subagent, `session` present iff main.
- `agentId` IS carried per-message (self-describing; duplicated across a flush by design).
  `isSubagent` is derived server-side from `type`/presence of `agentId` — not sent per message.
- `raw` is per LINE (`rawLines`), keyed by `lineUuid`; a line's N fanned-out messages share it.
- Server derives `toolCall`/`toolResult` tables from each message's `toolCall`/`toolResult` fields.

### Input types (`packages/core`) + runtime validation (zod, at the route)

```ts
interface RepoIdentity { host: string; owner: string; ownerType: "user"|"org"; repoName: string; }
interface TokenUsage { input: number; output: number; cached: number; thinking: number; }

type MsgType = "user"|"assistant"|"system"|"toolCall"|"toolResult"
             | "progress"|"systemEvent"|"queueOperation"|"fileSnapshot"|"summary";

interface NormalizedMessage {
  lineUuid: string; subIndex: number;              // → UNIQUE(lineUuid, subIndex)
  sessionId: string; source: string; sourceSchemaVersion: number;
  msgType: MsgType; timestamp: string; lineNumber: number;
  content?: string; thinking?: string; model?: string; role?: string; parentUuid?: string;
  tokens?: TokenUsage;
  toolCall?: { id: string; name: string; input: unknown };
  toolResult?: { callId: string; output: string; status: "success"|"failure" };
  agentId?: string;                                // per-message (subagent transcripts); null on main
}

interface RawLine { lineUuid: string; raw: string; }               // redacted verbatim source line
interface AgentInfo { agentId: string; agentType?: string; description?: string; spawnDepth?: number; spawnToolUseId?: string; }
interface SessionFields { model?: string; title?: string; cwd?: string; gitBranch?: string; gitCommit?: string; cliVersion?: string; permissionMode?: string; }

interface IngestBase {
  sessionId: string; sourceRelativePath: string;
  repo: RepoIdentity; rawLines: RawLine[]; messages: NormalizedMessage[];
}
type IngestPayload =
  | (IngestBase & { type: "main";     session: SessionFields })    // session, no agent
  | (IngestBase & { type: "subagent"; agent: AgentInfo });         // agent, no session
```

```ts
const zRepo = z.object({ host: z.string(), owner: z.string(), ownerType: z.enum(["user","org"]), repoName: z.string() });
const zTokens = z.object({ input: z.number().int().nonnegative(), output: z.number().int().nonnegative(),
                           cached: z.number().int().nonnegative(), thinking: z.number().int().nonnegative() });
const zMessage = z.object({
  lineUuid: z.string(), subIndex: z.number().int().nonnegative(),
  sessionId: z.string(), source: z.string(), sourceSchemaVersion: z.number().int(),
  msgType: z.enum(["user","assistant","system","toolCall","toolResult","progress","systemEvent","queueOperation","fileSnapshot","summary"]),
  timestamp: z.string(), lineNumber: z.number().int().positive(),
  content: z.string().optional(), thinking: z.string().optional(), model: z.string().optional(),
  role: z.string().optional(), parentUuid: z.string().optional(), tokens: zTokens.optional(),
  toolCall: z.object({ id: z.string(), name: z.string(), input: z.unknown() }).optional(),
  toolResult: z.object({ callId: z.string(), output: z.string(), status: z.enum(["success","failure"]) }).optional(),
  agentId: z.string().optional(),
});
const zBase = { sessionId: z.string(), sourceRelativePath: z.string(), repo: zRepo,
  rawLines: z.array(z.object({ lineUuid: z.string(), raw: z.string() })), messages: z.array(zMessage) };
const zIngest = z.discriminatedUnion("type", [
  z.object({ ...zBase, type: z.literal("main"),
    session: z.object({ model: z.string().optional(), title: z.string().optional(), cwd: z.string().optional(),
      gitBranch: z.string().optional(), gitCommit: z.string().optional(), cliVersion: z.string().optional(),
      permissionMode: z.string().optional() }) }),
  z.object({ ...zBase, type: z.literal("subagent"),
    agent: z.object({ agentId: z.string(), agentType: z.string().optional(), description: z.string().optional(),
      spawnDepth: z.number().int().optional(), spawnToolUseId: z.string().optional() }) }),
]);
```

Responses:
```ts
type IngestResponse =
  | { ingested: number; deduped: number }   // 200
  | { error: "sessionNotFound" }            // 409 (subagent flush, session absent)
  | { error: "unauthorized" }               // 401
  | { error: "repoNotWritable" };           // 403
```

Server per request (one txn):
1. resolve `userId` from JWT.
2. upsert `repos`; auto-grant `userRepos`; auto-link `orgRepos` if `ownerType=org` matches a seeded org.
3. `type==="main"` → upsert `sessions` (+ `session` enrichment); `type==="subagent"` → 409 if
   session missing (I2), else upsert `subagents` from `agent` (I5).
4. insert `messages` `ON CONFLICT("lineUuid","subIndex") DO NOTHING`; store each line's `raw`; `tokenUsage`.
5. **derive tool tables**: per message, delete-and-replace its `toolCall`/`toolResult` rows from its `toolCall`/`toolResult` fields.
6. **resolve `parentAgentId`** (I4): `WHERE "sessionId"=:s AND "parentAgentId" IS NULL AND
   "spawnDepth">1`, match `spawnToolUseId → toolCall.toolId → toolCall.messageId →
   messages.agentId` (≠ child).

## Reconciliation

| Case | Handling |
|------|----------|
| Subagent file before session | 409, watermark unadvanced, retried next cycle (I2) |
| Depth-2 parent tool_use not ingested | `parentAgentId` NULL; resolved on later flush (I4) |
| `.meta.json` missing | subagents row created, label fields NULL, upgraded later (I5) |
| Re-ingest / retry / rescan | `(lineUuid,subIndex)` dedupe; tool rows delete-and-replace; subagent/session upserts idempotent |
| Parser improved | server re-runs `adapter.parse` over stored `raw` for messages below current `sourceSchemaVersion` |
| Rollups | none stored; derived on read (S1) |

## Watcher structure (`packages/cli/src/watcher/`, DI'd)

`startWatcher(config, deps)` with injected `fs`, `clock`, `sink` (HttpSink / InMemorySink), and
the `SourceAdapter`. Tests: temp dir + fake clock + in-memory sink → append lines, assert sink
received the parsed records + raw, watermark advances, restart resumes, 409 retries, torn line
self-heals, subagent + `.meta.json` produce the agent block, fan-out yields N messages per line.

## Open Questions

1. **Watermark file** — `~/.samskara/state.json`, camelCase keys, per-file `FileState`:
   `{ filePath, source, sessionId, type: "main"|"subagent", agentId, lastMtime, lastSize,
   retryCount, lastError, cursor: { kind:"line", lastLineProcessed } }`. `type`/`agentId`
   let the driver order sends (main-before-subagent) and route flushes without re-parsing the path.
   (`type` here = file kind; `cursor.kind` = resume-cursor kind — different objects, no collision.)
2. **`content` for a tool_use/tool_result message** — store the block verbatim (JSON-encoded text) vs a projected string; server derives the tool table from it either way.
3. **provider mapping** — `model`→`provider` (`claude-*`→`anthropic`) at parse time.

## External Dependencies & Fallback Chain

None new — internal (Postgres, Drizzle) + local filesystem. `chokidar` NOT used (poll-glob).
