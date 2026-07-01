// AI-generated. See PROMPT.md for the prompts and model used.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installHooksCommand, uninstallHooksCommand } from "../src/commands/install-hooks.js";

let dir: string;
let settingsPath: string;
const sink = { write: () => true } as unknown as NodeJS.WritableStream;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cs-hooks-"));
  settingsPath = join(dir, "settings.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

type Settings = {
  hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
} & Record<string, unknown>;

const read = (): Settings => JSON.parse(readFileSync(settingsPath, "utf8"));
const commands = (s: Settings, event: string): (string | undefined)[] =>
  (s.hooks?.[event] ?? []).flatMap((m) => (m.hooks ?? []).map((h) => h.command));
// Managed hooks carry a stable `claude-sessions:<subcommand>` marker regardless
// of the (machine-specific) absolute path they invoke.
const hasManaged = (s: Settings, event: string, subcommand: string): boolean =>
  commands(s, event).some((c) => (c ?? "").includes(`claude-sessions:${subcommand}`));
const cliEntry = "/abs/path/to/main.js";
const install = () => installHooksCommand({ settingsPath, cliEntry, stdout: sink, stderr: sink });

describe("install-hooks", () => {
  it("creates settings.json with the SessionStart, UserPromptSubmit and Stop hooks", () => {
    const code = install();
    expect(code).toBe(0);
    const s = read();
    expect(hasManaged(s, "SessionStart", "ensure")).toBe(true);
    expect(hasManaged(s, "UserPromptSubmit", "prompt-hook")).toBe(true);
    expect(hasManaged(s, "Stop", "stop-hook")).toBe(true);
    // Commands are absolute (no PATH dependency) and reference the CLI entry.
    expect(commands(s, "SessionStart")[0]).toContain(cliEntry);
    expect(commands(s, "SessionStart")[0]).not.toMatch(/^claude-sessions /);
  });

  it("is idempotent — no duplicate entries on re-run", () => {
    install();
    install();
    const s = read();
    expect(
      commands(s, "SessionStart").filter((c) => (c ?? "").includes("claude-sessions:ensure")),
    ).toHaveLength(1);
    expect(
      commands(s, "UserPromptSubmit").filter((c) =>
        (c ?? "").includes("claude-sessions:prompt-hook"),
      ),
    ).toHaveLength(1);
    expect(
      commands(s, "Stop").filter((c) => (c ?? "").includes("claude-sessions:stop-hook")),
    ).toHaveLength(1);
  });

  it("preserves unrelated keys and a pre-existing Stop hook", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        model: "opus",
        hooks: { Stop: [{ hooks: [{ type: "command", command: "echo hi" }] }] },
      }),
    );
    install();
    const s = read();
    expect(s.model).toBe("opus");
    // Our Stop hook is appended alongside the user's existing one.
    expect(commands(s, "Stop")).toContain("echo hi");
    expect(hasManaged(s, "Stop", "stop-hook")).toBe(true);
    expect(hasManaged(s, "SessionStart", "ensure")).toBe(true);
  });

  it("uninstall removes only our entries, keeping others", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: "other" }] }],
          Stop: [{ hooks: [{ type: "command", command: "echo hi" }] }],
        },
      }),
    );
    install();
    uninstallHooksCommand({ settingsPath, stdout: sink, stderr: sink });
    const s = read();
    expect(commands(s, "SessionStart")).toContain("other");
    expect(hasManaged(s, "SessionStart", "ensure")).toBe(false);
    expect(commands(s, "Stop")).toContain("echo hi");
    expect(hasManaged(s, "Stop", "stop-hook")).toBe(false);
    expect(hasManaged(s, "UserPromptSubmit", "prompt-hook")).toBe(false);
  });

  it("uninstall drops the hooks key entirely when nothing else remains", () => {
    install();
    uninstallHooksCommand({ settingsPath, stdout: sink, stderr: sink });
    expect(read().hooks).toBeUndefined();
  });
});
