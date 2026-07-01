// AI-generated. See PROMPT.md for the prompts and model used.

import { existsSync, renameSync, statSync, unlinkSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enableCommand } from "../src/commands/enable.js";
import { syncCommand } from "../src/commands/sync.js";
import { listRepos } from "../src/config/repos.js";
import { getFileState } from "../src/config/state.js";
import { UploadClient } from "../src/upload/client.js";
import { consumeFile } from "../src/watcher/consume.js";
import { makeTempGitRepo } from "./helpers/git-repo.js";
import { type MockServerHandle, startMockServer } from "./helpers/mock-server.js";
import {
  type FixtureEnv,
  appendToSessionFile,
  buildEvent,
  createSessionFile,
  makeFixtureEnv,
} from "./helpers/tmp-jsonl.js";

let fixture: FixtureEnv;
let server: MockServerHandle;

beforeEach(async () => {
  fixture = makeFixtureEnv();
  server = await startMockServer();
});

afterEach(async () => {
  fixture.cleanup();
  await server.stop();
});

const buildClient = (delays: readonly number[] = []): UploadClient =>
  new UploadClient({ serverUrl: server.url, token: "test-token", retryDelaysMs: delays });

const ingestCalls = (): unknown[] =>
  server.requests.filter((r) => r.path === "/api/ingest").map((r) => r.body);

describe("consume + sync (REQ-013, REQ-014)", () => {
  it("REQ-013: backfill ingests every pre-existing JSONL on enable", async () => {
    const repo = makeTempGitRepo("git@github.com:fixture/backfill.git");
    try {
      // 5 pre-existing sessions before enable.
      for (let i = 0; i < 5; i++) {
        const sid = `session-back-${i}`;
        createSessionFile(fixture.projectsRoot, repo.path, sid, [
          buildEvent({ uuid: `u${i}-1`, sessionId: sid, cwd: repo.path }),
          buildEvent({ uuid: `u${i}-2`, sessionId: sid, cwd: repo.path, type: "assistant" }),
        ]);
      }
      const code = await enableCommand({
        path: repo.path,
        client: buildClient(),
      });
      expect(code).toBe(0);
      const ingests = ingestCalls();
      expect(ingests.length).toBe(5);
    } finally {
      repo.cleanup();
    }
  });
});

describe("consume offset persistence (REQ-015)", () => {
  it("re-running consume after a successful upload only ingests events past the offset", async () => {
    const repo = makeTempGitRepo("git@github.com:fixture/resume.git");
    try {
      const sid = "session-resume-1";
      const file = createSessionFile(fixture.projectsRoot, repo.path, sid, [
        buildEvent({ uuid: "u1", sessionId: sid, cwd: repo.path }),
        buildEvent({ uuid: "u2", sessionId: sid, cwd: repo.path, type: "assistant" }),
      ]);
      await enableCommand({
        path: repo.path,
        client: buildClient(),
      });
      const initial = ingestCalls();
      expect(initial.length).toBe(1);
      const initialEventCount = (initial[0] as { events: unknown[] }).events.length;
      expect(initialEventCount).toBe(2);

      const sizeAfterFirst = statSync(file.path).size;
      const state = getFileState(file.path);
      expect(state?.byte_offset).toBe(sizeAfterFirst);

      // Append more events and run sync.
      appendToSessionFile(file.path, [buildEvent({ uuid: "u3", sessionId: sid, cwd: repo.path })]);
      await syncCommand({ client: buildClient() });
      const after = ingestCalls();
      expect(after.length).toBe(2);
      const secondBatch = (after[1] as { events: { event_uuid: string }[] }).events;
      expect(secondBatch.length).toBe(1);
      expect(secondBatch[0]?.event_uuid).toBe("u3");
    } finally {
      repo.cleanup();
    }
  });
});

describe("retry + offset semantics (REQ-045)", () => {
  it("server returns 500 thrice then 200 — offset advances only on success and no duplicates", async () => {
    const repo = makeTempGitRepo("git@github.com:fixture/retry.git");
    try {
      const sid = "session-retry-1";
      const file = createSessionFile(fixture.projectsRoot, repo.path, sid, [
        buildEvent({ uuid: "r1", sessionId: sid, cwd: repo.path }),
        buildEvent({ uuid: "r2", sessionId: sid, cwd: repo.path, type: "assistant" }),
      ]);
      // Enable first (with the default OK responses); skip backfill so we
      // can prime failures for the next consume call cleanly.
      await enableCommand({
        path: repo.path,
        client: buildClient(),
        skipBackfill: true,
      });
      // Reset offsets so the next consume re-ingests the file.
      // (enable's skipBackfill=true means no offset is set.)
      expect(getFileState(file.path)).toBe(null);

      // Three 500s, then default 200. Use a client with 3 retries (0ms each)
      // so the same call burns all three failures before the default 200.
      server.enqueue("/api/ingest", 500, { error: "boom" });
      server.enqueue("/api/ingest", 500, { error: "boom" });
      server.enqueue("/api/ingest", 500, { error: "boom" });

      const retryClient = new UploadClient({
        serverUrl: server.url,
        token: "test-token",
        retryDelaysMs: [0, 0, 0, 0],
      });
      await consumeFile(file.path, retryClient);
      const state = getFileState(file.path);
      expect(state?.byte_offset).toBe(statSync(file.path).size);

      // Server saw exactly 4 ingest calls (3 fail + 1 success). Run consume
      // again — no new bytes, no new ingest call.
      const beforeCount = ingestCalls().length;
      expect(beforeCount).toBe(4);
      await consumeFile(file.path, retryClient);
      expect(ingestCalls().length).toBe(beforeCount);

      // Also verify: a client with NO retries against pure failures throws
      // and leaves the offset alone.
      const file2 = createSessionFile(fixture.projectsRoot, repo.path, "session-retry-2", [
        buildEvent({ uuid: "x1", sessionId: "session-retry-2", cwd: repo.path }),
      ]);
      server.enqueue("/api/ingest", 500, { error: "boom" });
      const noRetry = new UploadClient({
        serverUrl: server.url,
        token: "test-token",
        retryDelaysMs: [],
      });
      let threw = false;
      try {
        await consumeFile(file2.path, noRetry);
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
      expect(getFileState(file2.path)).toBe(null);
    } finally {
      repo.cleanup();
    }
  });
});

describe("ingest verification (false-2xx guard)", () => {
  it("a 2xx under-count throws and leaves the offset put; the next tick re-reads and succeeds", async () => {
    const repo = makeTempGitRepo("git@github.com:fixture/verify.git");
    try {
      const sid = "session-verify-1";
      const file = createSessionFile(fixture.projectsRoot, repo.path, sid, [
        buildEvent({ uuid: "v1", sessionId: sid, cwd: repo.path }),
        buildEvent({ uuid: "v2", sessionId: sid, cwd: repo.path, type: "assistant" }),
      ]);
      await enableCommand({ path: repo.path, client: buildClient(), skipBackfill: true });
      expect(getFileState(file.path)).toBe(null);

      // First consume: 200 but the server only accounts for 1 of the 2 events
      // sent (a transient partial-commit / deploy-mid-request). This must throw
      // and NOT advance the offset — exactly the false-2xx that stranded events.
      server.enqueue("/api/ingest", 200, {
        ok: true,
        accepted_events: 1,
        skipped_duplicates: 0,
      });
      const client = buildClient();
      await expect(consumeFile(file.path, client)).rejects.toThrow(/verification failed/);
      expect(getFileState(file.path)).toBe(null);

      // Next watcher tick re-reads from the un-advanced offset; the default 200
      // now honestly echoes 2 accepted, so the offset advances and dedupe holds.
      await consumeFile(file.path, client);
      const state = getFileState(file.path);
      expect(state?.byte_offset).toBe(statSync(file.path).size);
      expect(ingestCalls().length).toBe(2);
    } finally {
      repo.cleanup();
    }
  });

  it("a persistent under-count with no retries throws and leaves the offset untouched", async () => {
    const repo = makeTempGitRepo("git@github.com:fixture/verify2.git");
    try {
      const sid = "session-verify-2";
      const file = createSessionFile(fixture.projectsRoot, repo.path, sid, [
        buildEvent({ uuid: "w1", sessionId: sid, cwd: repo.path }),
        buildEvent({ uuid: "w2", sessionId: sid, cwd: repo.path, type: "assistant" }),
      ]);
      await enableCommand({ path: repo.path, client: buildClient(), skipBackfill: true });
      expect(getFileState(file.path)).toBe(null);

      server.setHandler("/api/ingest", () => ({
        status: 200,
        body: { ok: true, accepted_events: 0, skipped_duplicates: 0 },
      }));
      const noRetry = new UploadClient({
        serverUrl: server.url,
        token: "test-token",
        retryDelaysMs: [],
      });
      let threw = false;
      try {
        await consumeFile(file.path, noRetry);
      } catch (err) {
        threw = true;
        expect((err as Error).name).toBe("IngestVerificationError");
      }
      expect(threw).toBe(true);
      expect(getFileState(file.path)).toBe(null);
    } finally {
      repo.cleanup();
    }
  });
});

describe("sync --verify reconciliation", () => {
  it("re-pushes a session the server is missing events for, and no-ops when counts match", async () => {
    const repo = makeTempGitRepo("git@github.com:fixture/reconcile.git");
    try {
      const sid = "session-reconcile-1";
      createSessionFile(fixture.projectsRoot, repo.path, sid, [
        buildEvent({ uuid: "rc1", sessionId: sid, cwd: repo.path }),
        buildEvent({ uuid: "rc2", sessionId: sid, cwd: repo.path, type: "assistant" }),
      ]);
      // Enable without backfilling so the server starts with zero events —
      // exactly the "title present, transcript empty" broken state.
      await enableCommand({ path: repo.path, client: buildClient(), skipBackfill: true });

      // Server reports 0 events for this session; local has 2 → must re-push.
      server.setMethodHandler("GET", `/api/sessions/${sid}/event-count`, () => ({
        status: 200,
        body: { count: 0 },
      }));
      await syncCommand({ client: buildClient(), verify: true });
      const ingests = ingestCalls();
      expect(ingests.length).toBe(1);
      expect((ingests[0] as { events: unknown[] }).events.length).toBe(2);

      // Now the server "has" all events; verify again → no new ingest.
      server.setMethodHandler("GET", `/api/sessions/${sid}/event-count`, () => ({
        status: 200,
        body: { count: 2 },
      }));
      await syncCommand({ client: buildClient(), verify: true });
      expect(ingestCalls().length).toBe(1);
    } finally {
      repo.cleanup();
    }
  });

  it("falls back to /events when the server lacks the /event-count route (older server)", async () => {
    const repo = makeTempGitRepo("git@github.com:fixture/reconcile-old.git");
    try {
      const sid = "session-reconcile-old";
      createSessionFile(fixture.projectsRoot, repo.path, sid, [
        buildEvent({ uuid: "ro1", sessionId: sid, cwd: repo.path }),
        buildEvent({ uuid: "ro2", sessionId: sid, cwd: repo.path, type: "assistant" }),
      ]);
      await enableCommand({ path: repo.path, client: buildClient(), skipBackfill: true });

      // Older server: no /event-count route (404). Fallback reads /events,
      // which already returns both events → verify must be a no-op, NOT a
      // spurious re-push (the bug when 404 was conflated with "0 events").
      server.setMethodHandler("GET", `/api/sessions/${sid}/event-count`, () => ({
        status: 404,
        body: { error: "not found" },
      }));
      server.setMethodHandler("GET", `/api/sessions/${sid}/events`, () => ({
        status: 200,
        body: { events: [{ event_uuid: "ro1" }, { event_uuid: "ro2" }] },
      }));
      await syncCommand({ client: buildClient(), verify: true });
      expect(ingestCalls().length).toBe(0);
    } finally {
      repo.cleanup();
    }
  });
});

describe("inode replacement (EDGE-002)", () => {
  it("replacing the JSONL with a different inode re-ingests new content without duplicates", async () => {
    const repo = makeTempGitRepo("git@github.com:fixture/inode.git");
    try {
      const sid = "session-inode-1";
      const file = createSessionFile(fixture.projectsRoot, repo.path, sid, [
        buildEvent({ uuid: "i1", sessionId: sid, cwd: repo.path }),
        buildEvent({ uuid: "i2", sessionId: sid, cwd: repo.path, type: "assistant" }),
      ]);
      await enableCommand({ path: repo.path, client: buildClient() });
      const before = ingestCalls();
      expect(before.length).toBe(1);

      // Replace the file with a smaller new inode containing one event.
      unlinkSync(file.path);
      const replacement = createSessionFile(fixture.projectsRoot, repo.path, sid, [
        buildEvent({ uuid: "i1", sessionId: sid, cwd: repo.path }), // dup uuid — server dedupes
      ]);
      // Force: we kept the same path, but it's now a fresh file.
      expect(existsSync(replacement.path)).toBe(true);
      expect(statSync(replacement.path).size).toBeLessThan(2_000);

      await consumeFile(replacement.path, buildClient());
      const after = ingestCalls();
      expect(after.length).toBe(2);
      const events = (after[1] as { events: { event_uuid: string }[] }).events;
      // We re-emit i1 — it's a duplicate by event_uuid; the server dedupe
      // table handles uniqueness. Test asserts that we read from byte 0.
      expect(events.map((e) => e.event_uuid)).toEqual(["i1"]);
    } finally {
      repo.cleanup();
    }
  });
});

describe("mid-session enable (EDGE-009)", () => {
  it("write 3 events, enable, write 3 more — all 6 ingested (across calls)", async () => {
    const repo = makeTempGitRepo("git@github.com:fixture/mid-session.git");
    try {
      const sid = "session-mid-1";
      const file = createSessionFile(fixture.projectsRoot, repo.path, sid, [
        buildEvent({ uuid: "m1", sessionId: sid, cwd: repo.path }),
        buildEvent({ uuid: "m2", sessionId: sid, cwd: repo.path, type: "assistant" }),
        buildEvent({ uuid: "m3", sessionId: sid, cwd: repo.path }),
      ]);
      await enableCommand({ path: repo.path, client: buildClient() });
      const firstBatch = ingestCalls();
      expect(firstBatch.length).toBe(1);
      const firstEvents = (firstBatch[0] as { events: { event_uuid: string }[] }).events;
      expect(firstEvents.map((e) => e.event_uuid)).toEqual(["m1", "m2", "m3"]);

      appendToSessionFile(file.path, [
        buildEvent({ uuid: "m4", sessionId: sid, cwd: repo.path, type: "assistant" }),
        buildEvent({ uuid: "m5", sessionId: sid, cwd: repo.path }),
        buildEvent({ uuid: "m6", sessionId: sid, cwd: repo.path, type: "assistant" }),
      ]);
      await syncCommand({ client: buildClient() });
      const all = ingestCalls();
      expect(all.length).toBe(2);
      const secondEvents = (all[1] as { events: { event_uuid: string }[] }).events;
      expect(secondEvents.map((e) => e.event_uuid)).toEqual(["m4", "m5", "m6"]);
    } finally {
      repo.cleanup();
    }
  });
});

describe("ingest chunking (server cap is 500/batch)", () => {
  it("a single 1200-event JSONL is split into 3 ingest POSTs of <=500 each", async () => {
    const repo = makeTempGitRepo("git@github.com:fixture/chunking.git");
    try {
      const sid = "session-chunked-1";
      const events = Array.from({ length: 1200 }, (_, i) =>
        buildEvent({
          uuid: `c${i}`,
          sessionId: sid,
          cwd: repo.path,
          type: i % 2 === 0 ? "user" : "assistant",
        }),
      );
      createSessionFile(fixture.projectsRoot, repo.path, sid, events);
      await enableCommand({ path: repo.path, client: buildClient() });
      const calls = ingestCalls() as Array<{ events: unknown[]; commits?: unknown[] }>;
      expect(calls.length).toBe(3);
      expect(calls[0]?.events.length).toBe(500);
      expect(calls[1]?.events.length).toBe(500);
      expect(calls[2]?.events.length).toBe(200);
      // Commits ride only on the first chunk (so the server doesn't receive
      // them three times). Other chunks may omit the field entirely.
      expect(calls[1]?.commits ?? undefined).toBeUndefined();
      expect(calls[2]?.commits ?? undefined).toBeUndefined();
    } finally {
      repo.cleanup();
    }
  });
});

describe("ingest payload is canonical, not raw", () => {
  it("user_msg/assistant_msg/tool_use payloads carry only canonical projection fields", async () => {
    const repo = makeTempGitRepo("git@github.com:fixture/payload-shape.git");
    try {
      const sid = "session-shape-1";
      const ts = "2026-05-09T10:00:00.000Z";
      // user prompt
      const ev1 = buildEvent({ uuid: "s1", sessionId: sid, cwd: repo.path, ts, text: "hi" });
      // assistant text + tool_use in one record
      const ev2 = {
        type: "assistant",
        uuid: "s2",
        parentUuid: "s1",
        timestamp: ts,
        sessionId: sid,
        cwd: repo.path,
        gitBranch: "main",
        version: "1.0.0",
        message: {
          role: "assistant",
          model: "claude-3-5-sonnet",
          content: [
            { type: "text", text: "running ls" },
            { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls -la" } },
          ],
          usage: { input_tokens: 7, output_tokens: 3 },
        },
      };
      createSessionFile(fixture.projectsRoot, repo.path, sid, [ev1, ev2]);

      await enableCommand({ path: repo.path, client: buildClient() });

      const calls = ingestCalls();
      expect(calls.length).toBe(1);
      const payload = calls[0] as {
        events: Array<{ type: string; payload: Record<string, unknown> }>;
      };
      const byType = Object.fromEntries(payload.events.map((e) => [e.type, e.payload]));

      expect(byType.user_msg).toEqual({ content_md: "hi" });

      expect(byType.assistant_msg).toMatchObject({
        content_md: "running ls",
        model: "claude-3-5-sonnet",
        usage: { input_tokens: 7, output_tokens: 3 },
      });
      // No raw leak.
      expect(byType.assistant_msg).not.toHaveProperty("message");
      expect(byType.assistant_msg).not.toHaveProperty("uuid");

      expect(byType.tool_use).toMatchObject({
        tool: "Bash",
        tool_use_id: "t1",
        input_summary: "ls -la",
      });
      expect(byType.tool_use).not.toHaveProperty("message");
    } finally {
      repo.cleanup();
    }
  });

  it("system + attachment payloads forward structured `data` to the wire", async () => {
    const repo = makeTempGitRepo("git@github.com:fixture/sys-data.git");
    try {
      const sid = "session-sys-1";
      const ts = "2026-05-09T10:00:00.000Z";
      const userEv = buildEvent({ uuid: "s1", sessionId: sid, cwd: repo.path, ts, text: "hi" });
      const attachmentEv = {
        type: "attachment",
        uuid: "att1",
        parentUuid: "s1",
        timestamp: ts,
        sessionId: sid,
        cwd: repo.path,
        attachment: {
          type: "hook_success",
          hookName: "SessionStart:startup",
          exitCode: 0,
          durationMs: 42,
          stdout: "OK\n",
        },
      };
      const turnDurationEv = {
        type: "system",
        uuid: "td1",
        parentUuid: "s1",
        timestamp: ts,
        sessionId: sid,
        subtype: "turn_duration",
        durationMs: 8421,
        messageCount: 12,
      };
      createSessionFile(fixture.projectsRoot, repo.path, sid, [
        userEv,
        attachmentEv,
        turnDurationEv,
      ]);

      await enableCommand({ path: repo.path, client: buildClient() });

      const calls = ingestCalls();
      expect(calls.length).toBe(1);
      const payload = calls[0] as {
        events: Array<{
          event_uuid: string;
          type: string;
          payload: Record<string, unknown>;
        }>;
      };
      const byUuid = Object.fromEntries(payload.events.map((e) => [e.event_uuid, e]));

      expect(byUuid.att1?.type).toBe("system");
      expect(byUuid.att1?.payload).toMatchObject({
        kind: "attachment.hook_success",
        data: {
          attachment: {
            type: "hook_success",
            hookName: "SessionStart:startup",
            exitCode: 0,
            durationMs: 42,
          },
        },
      });

      expect(byUuid.td1?.type).toBe("system");
      expect(byUuid.td1?.payload).toMatchObject({
        kind: "turn_duration",
        data: { durationMs: 8421, messageCount: 12 },
      });
    } finally {
      repo.cleanup();
    }
  });
});

// Touch unused imports for lint.
void renameSync;
void listRepos;
