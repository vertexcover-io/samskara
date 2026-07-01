// AI-generated. See PROMPT.md for the prompts and model used.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { resolveCliEntry } from "../config/daemon.js";

/**
 * The hooks we manage, keyed by the CLI subcommand each runs. `SessionStart`
 * keeps auth + the watcher up; `UserPromptSubmit` gives a new session a
 * provisional title on its first prompt; `Stop` makes the in-loop agent author
 * its own session summary before the turn ends (the primary summarization
 * trigger — there is no timer). Each also revives a dead watcher on entry.
 */
const MANAGED_HOOKS: { event: string; subcommand: string }[] = [
  { event: "SessionStart", subcommand: "ensure" },
  { event: "UserPromptSubmit", subcommand: "prompt-hook" },
  { event: "Stop", subcommand: "stop-hook" },
];

const MANAGED_EVENTS = new Set(MANAGED_HOOKS.map((h) => h.event));

/**
 * A stable marker embedded in every managed hook command, independent of the
 * absolute path (which is machine-specific). Idempotency and uninstall match on
 * this marker, so re-running install after an upgrade — or on a different
 * machine — recognizes and refreshes its own hooks rather than duplicating them.
 */
const managedMarker = (subcommand: string): string => `claude-sessions:${subcommand}`;
const isManagedCommand = (command: string | undefined): boolean =>
  !!command && MANAGED_HOOKS.some((h) => command.includes(managedMarker(h.subcommand)));

/**
 * Build the absolute hook command. Invoking `<node> <abs main.js> <subcommand>`
 * removes the dependency on `claude-sessions` being on PATH when Claude Code
 * spawns the hook — a missing PATH was a silent way for capture to break. The
 * trailing `# claude-sessions:<subcommand>` comment is the stable match marker.
 */
const buildCommand = (subcommand: string, cliEntry: string): string =>
  `${process.execPath} ${cliEntry} ${subcommand} # ${managedMarker(subcommand)}`;

export interface InstallHooksOptions {
  /** Override the settings.json path (tests). */
  settingsPath?: string;
  /** Override the resolved CLI entry (tests). */
  cliEntry?: string;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

interface HookCommand {
  type?: string;
  command?: string;
}
interface HookMatcher {
  matcher?: string;
  hooks?: HookCommand[];
}

const defaultSettingsPath = (): string => join(homedir(), ".claude", "settings.json");

const readSettings = (path: string): Record<string, unknown> => {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`failed to parse ${path} — fix or remove it, then re-run`);
  }
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
};

const writeSettings = (path: string, settings: Record<string, unknown>): void => {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
};

const asMatchers = (v: unknown): HookMatcher[] => (Array.isArray(v) ? (v as HookMatcher[]) : []);

const hasManaged = (matchers: HookMatcher[], subcommand: string): boolean =>
  matchers.some((m) =>
    (m.hooks ?? []).some((h) => (h.command ?? "").includes(managedMarker(subcommand))),
  );

export const installHooksCommand = (opts: InstallHooksOptions = {}): number => {
  const path = opts.settingsPath ?? defaultSettingsPath();
  const cliEntry = opts.cliEntry ?? resolveCliEntry();
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;

  let settings: Record<string, unknown>;
  try {
    settings = readSettings(path);
  } catch (err) {
    stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  const hooks =
    settings.hooks && typeof settings.hooks === "object"
      ? (settings.hooks as Record<string, unknown>)
      : {};

  const installed: string[] = [];
  for (const mh of MANAGED_HOOKS) {
    const matchers = asMatchers(hooks[mh.event]);
    if (hasManaged(matchers, mh.subcommand)) continue;
    matchers.push({
      hooks: [{ type: "command", command: buildCommand(mh.subcommand, cliEntry) }],
    });
    hooks[mh.event] = matchers;
    installed.push(mh.event);
  }

  if (installed.length === 0) {
    stdout.write(`hooks already installed in ${path}\n`);
    return 0;
  }

  settings.hooks = hooks;
  writeSettings(path, settings);
  stdout.write(`installed ${installed.join(" + ")} hook(s) in ${path}\n`);
  return 0;
};

export const uninstallHooksCommand = (opts: InstallHooksOptions = {}): number => {
  const path = opts.settingsPath ?? defaultSettingsPath();
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;

  if (!existsSync(path)) {
    stdout.write("nothing to uninstall\n");
    return 0;
  }

  let settings: Record<string, unknown>;
  try {
    settings = readSettings(path);
  } catch (err) {
    stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  const hooks =
    settings.hooks && typeof settings.hooks === "object"
      ? (settings.hooks as Record<string, unknown>)
      : {};

  // Rebuild without empty keys (rather than `delete`) so an emptied hooks
  // object drops out entirely instead of serializing as `{}`.
  let removed = false;
  const nextHooks: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(hooks)) {
    if (!MANAGED_EVENTS.has(k) || !Array.isArray(v)) {
      nextHooks[k] = v;
      continue;
    }
    const filtered = asMatchers(v)
      .map((m) => {
        const kept = (m.hooks ?? []).filter((h) => !isManagedCommand(h.command));
        if (kept.length !== (m.hooks ?? []).length) removed = true;
        return { ...m, hooks: kept };
      })
      .filter((m) => (m.hooks ?? []).length > 0);
    if (filtered.length > 0) nextHooks[k] = filtered;
  }

  if (!removed) {
    stdout.write("nothing to uninstall\n");
    return 0;
  }

  const nextSettings: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(settings)) {
    if (k === "hooks") {
      if (Object.keys(nextHooks).length > 0) nextSettings[k] = nextHooks;
    } else {
      nextSettings[k] = v;
    }
  }

  writeSettings(path, nextSettings);
  stdout.write(`removed claude-sessions hooks from ${path}\n`);
  return 0;
};
