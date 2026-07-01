// AI-generated. See PROMPT.md for the prompts and model used.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { CanonicalSession } from "@claude-sessions/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stopHookCommand } from "../src/commands/stop-hook.js";
import type { SettingsFile } from "../src/config/settings.js";
import type { WatermarkState } from "../src/summarizer/index.js";
import type { UploadClient } from "../src/upload/client.js";

const settings = (over: Partial<SettingsFile> = {}): SettingsFile => ({
  version: 1,
  summary_enabled: true,
  learnings_enabled: false,
  ...over,
});

let dir: string;
let transcript: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cs-stophook-"));
  transcript = join(dir, "session.jsonl");
  writeFileSync(transcript, "{}\n");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const dummyClient = {} as unknown as UploadClient;

const fakeSession = (n: number): CanonicalSession =>
  ({
    events: Array.from({ length: n }, (_, i) => ({ event_uuid: `e${i}` })),
  }) as unknown as CanonicalSession;

const captureStdout = (): { stream: NodeJS.WritableStream; get: () => string } => {
  let data = "";
  const stream = {
    write: (s: string) => {
      data += s;
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  return { stream, get: () => data };
};

const run = async (
  input: unknown,
  opts: Partial<Parameters<typeof stopHookCommand>[0]> = {},
): Promise<{ code: number; out: string }> => {
  const out = captureStdout();
  const raw = typeof input === "string" ? input : JSON.stringify(input);
  const code = await stopHookCommand({
    client: dummyClient,
    stdin: Readable.from([raw]),
    stdout: out.stream,
    readSession: () => fakeSession(50),
    readSettingsImpl: () => settings(),
    // Stub the daemon revive so the hook test never spawns a real watcher.
    reviveWatcherImpl: () => 1234,
    readWatermarkImpl: async (): Promise<WatermarkState> => ({
      summary: { status: "ok" } as WatermarkState["summary"],
      fresh: false,
      delta: 99,
    }),
    ...opts,
  });
  return { code, out: out.get() };
};

const isBlock = (out: string): boolean => {
  if (!out.trim()) return false;
  const parsed = JSON.parse(out) as { decision?: string; reason?: string };
  return (
    parsed.decision === "block" && typeof parsed.reason === "string" && parsed.reason.length > 0
  );
};

describe("stopHookCommand", () => {
  it("blocks once when a substantive session has no fresh summary", async () => {
    const { code, out } = await run({
      session_id: "sess-1",
      transcript_path: transcript,
      stop_hook_active: false,
    });
    expect(code).toBe(0);
    expect(isBlock(out)).toBe(true);
    expect(out).toContain("summarize --current --from-agent");
  });

  it("allows the stop when stop_hook_active is already true (loop guard)", async () => {
    const { out } = await run({
      session_id: "sess-1",
      transcript_path: transcript,
      stop_hook_active: true,
    });
    expect(isBlock(out)).toBe(false);
    expect(out.trim()).toBe("");
  });

  it("allows the stop when a fresh summary already exists", async () => {
    const { out } = await run(
      { session_id: "sess-1", transcript_path: transcript, stop_hook_active: false },
      {
        readWatermarkImpl: async (): Promise<WatermarkState> => ({
          summary: { status: "ok" } as WatermarkState["summary"],
          fresh: true,
          delta: 1,
        }),
      },
    );
    expect(isBlock(out)).toBe(false);
  });

  it("allows the stop for a trivial session below the activity threshold", async () => {
    const { out } = await run(
      { session_id: "sess-1", transcript_path: transcript, stop_hook_active: false },
      { readSession: () => fakeSession(3) },
    );
    expect(isBlock(out)).toBe(false);
  });

  it("allows the stop when the watermark probe throws (unknown session / server down)", async () => {
    const probe = vi.fn(async () => {
      throw new Error("HTTP 404");
    });
    const { out } = await run(
      { session_id: "sess-1", transcript_path: transcript, stop_hook_active: false },
      {
        readWatermarkImpl: probe as unknown as Parameters<
          typeof stopHookCommand
        >[0]["readWatermarkImpl"],
      },
    );
    expect(probe).toHaveBeenCalled();
    expect(isBlock(out)).toBe(false);
  });

  it("allows the stop when session_id or transcript_path is missing", async () => {
    const a = await run({ transcript_path: transcript, stop_hook_active: false });
    const b = await run({ session_id: "sess-1", stop_hook_active: false });
    expect(isBlock(a.out)).toBe(false);
    expect(isBlock(b.out)).toBe(false);
  });

  it("allows the stop when the transcript path does not exist", async () => {
    const { out } = await run({
      session_id: "sess-1",
      transcript_path: join(dir, "missing.jsonl"),
      stop_hook_active: false,
    });
    expect(isBlock(out)).toBe(false);
  });

  it("never throws on malformed stdin", async () => {
    const { code, out } = await run("not json {{{");
    expect(code).toBe(0);
    expect(isBlock(out)).toBe(false);
  });

  it("allows the stop without nagging when summary is disabled", async () => {
    const { code, out } = await run(
      { session_id: "sess-1", transcript_path: transcript, stop_hook_active: false },
      { readSettingsImpl: () => settings({ summary_enabled: false }) },
    );
    expect(code).toBe(0);
    expect(isBlock(out)).toBe(false);
    expect(out.trim()).toBe("");
  });

  it("revives the watcher even when summaries are disabled (capture is independent)", async () => {
    let revived = 0;
    await run(
      { session_id: "sess-1", transcript_path: transcript, stop_hook_active: false },
      {
        readSettingsImpl: () => settings({ summary_enabled: false }),
        reviveWatcherImpl: () => {
          revived++;
          return 1234;
        },
      },
    );
    expect(revived).toBe(1);
  });

  it("omits the learnings clause and anchors when learnings are disabled", async () => {
    const { out } = await run(
      { session_id: "sess-1", transcript_path: transcript, stop_hook_active: false },
      { readSettingsImpl: () => settings({ learnings_enabled: false }) },
    );
    expect(isBlock(out)).toBe(true);
    expect(out).toContain("summarize --current --from-agent");
    expect(out).not.toContain("learnings");
    expect(out).not.toContain("event_uuid");
  });

  it("includes the learnings clause when learnings are enabled", async () => {
    const { out } = await run(
      { session_id: "sess-1", transcript_path: transcript, stop_hook_active: false },
      { readSettingsImpl: () => settings({ learnings_enabled: true }) },
    );
    expect(isBlock(out)).toBe(true);
    expect(out).toContain("learnings");
  });

  it("does not re-nag when only the summarize round-trip's own events were added", async () => {
    // Regression: the in-loop agent just authored a summary at event count 50.
    // Running `summarize`, its tool_result, the closing assistant message and the
    // injected block reason add ~5-6 events to the transcript *after* the
    // watermark snapshot. With the real readWatermark and the old 5-event margin,
    // that self-inflicted delta alone judged the summary stale and the hook nagged
    // forever. The Stop hook's freshness margin must absorb the round-trip.
    const summarizedAt = 50;
    const roundTripFootprint = 6;
    const out = captureStdout();
    const client = {
      getSession: async () => ({
        summary: {
          status: "ok",
          model: "agent",
          summarized_event_count: summarizedAt,
        },
      }),
    } as unknown as UploadClient;
    const code = await stopHookCommand({
      client,
      stdin: Readable.from([
        JSON.stringify({
          session_id: "sess-1",
          transcript_path: transcript,
          stop_hook_active: false,
        }),
      ]),
      stdout: out.stream,
      readSession: () => fakeSession(summarizedAt + roundTripFootprint),
      readSettingsImpl: () => settings(),
    });
    expect(code).toBe(0);
    expect(isBlock(out.get())).toBe(false);
  });
});
