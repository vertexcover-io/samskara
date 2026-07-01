// AI-generated. See PROMPT.md for the prompts and model used.

import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { promptHookCommand } from "../src/commands/prompt-hook.js";
import { HttpError, type SessionDetail, type UploadClient } from "../src/upload/client.js";

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

const clientWith = (getSession: () => Promise<SessionDetail>): UploadClient =>
  ({ getSession }) as unknown as UploadClient;

const run = async (
  input: unknown,
  getSession: () => Promise<SessionDetail>,
  reviveWatcherImpl: () => number | null = () => 1234,
): Promise<{ code: number; out: string }> => {
  const out = captureStdout();
  const raw = typeof input === "string" ? input : JSON.stringify(input);
  const code = await promptHookCommand({
    client: clientWith(getSession),
    stdin: Readable.from([raw]),
    stdout: out.stream,
    // Stub the daemon revive so the hook test never spawns a real watcher.
    reviveWatcherImpl,
  });
  return { code, out: out.get() };
};

const isInject = (out: string): boolean => {
  if (!out.trim()) return false;
  const parsed = JSON.parse(out) as {
    hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
  };
  const h = parsed.hookSpecificOutput;
  return (
    h?.hookEventName === "UserPromptSubmit" &&
    typeof h.additionalContext === "string" &&
    h.additionalContext.length > 0
  );
};

const detail = (summary: SessionDetail["summary"]): SessionDetail => ({ id: "sess-1", summary });

describe("promptHookCommand", () => {
  it("injects a provisional-title instruction when the session has no summary", async () => {
    const { code, out } = await run(
      { session_id: "sess-1", transcript_path: "/tmp/t.jsonl", prompt: "add a login form" },
      async () => detail(null),
    );
    expect(code).toBe(0);
    expect(isInject(out)).toBe(true);
    expect(out).toContain("summarize --current --from-agent --provisional");
  });

  it("injects when getSession 404s (brand-new, un-ingested session)", async () => {
    const { out } = await run(
      { session_id: "sess-1", transcript_path: "/tmp/t.jsonl" },
      async () => {
        throw new HttpError(404, "not found");
      },
    );
    expect(isInject(out)).toBe(true);
  });

  it("is silent when an ok summary already exists", async () => {
    const { out } = await run({ session_id: "sess-1", transcript_path: "/tmp/t.jsonl" }, async () =>
      detail({
        title: "Add login form",
        summary: "x",
        tags: [],
        files_touched: [],
        prs_referenced: [],
        tool_call_counts: {},
        status: "ok",
      }),
    );
    expect(out.trim()).toBe("");
  });

  it("is silent on a non-404 server error (fail open)", async () => {
    const { out } = await run(
      { session_id: "sess-1", transcript_path: "/tmp/t.jsonl" },
      async () => {
        throw new HttpError(500, "boom");
      },
    );
    expect(isInject(out)).toBe(false);
  });

  it("is silent when session_id is missing", async () => {
    const { out } = await run({ transcript_path: "/tmp/t.jsonl" }, async () => detail(null));
    expect(isInject(out)).toBe(false);
  });

  it("never throws on malformed stdin", async () => {
    const { code, out } = await run("not json {{{", async () => detail(null));
    expect(code).toBe(0);
    expect(isInject(out)).toBe(false);
  });

  it("revives the watcher on entry (recovery at every hook boundary)", async () => {
    let revived = 0;
    await run(
      { session_id: "sess-1" },
      async () => detail(null),
      () => {
        revived++;
        return 1234;
      },
    );
    expect(revived).toBe(1);
  });

  it("does not throw when the watcher revive fails", async () => {
    const { code } = await run(
      { session_id: "sess-1" },
      async () => detail(null),
      () => {
        throw new Error("spawn failed");
      },
    );
    expect(code).toBe(0);
  });
});
