#!/usr/bin/env node
// AI-generated. See PROMPT.md for the prompts and model used.

import { Command } from "commander";
import { buildClient } from "./commands/_client.js";
import { artifactsCommand } from "./commands/artifacts.js";
import { configCommand } from "./commands/config.js";
import { disableCommand } from "./commands/disable.js";
import { enableCommand } from "./commands/enable.js";
import { ensureCommand } from "./commands/ensure.js";
import { findCommand } from "./commands/find.js";
import { forkCommand } from "./commands/fork.js";
import { initCommand } from "./commands/init.js";
import { installHooksCommand, uninstallHooksCommand } from "./commands/install-hooks.js";
import { learningsCommand } from "./commands/learnings.js";
import { loginCommand } from "./commands/login.js";
import { logoutCommand } from "./commands/logout.js";
import { logsCommand } from "./commands/logs.js";
import { mcpCommand } from "./commands/mcp.js";
import { nameCommand } from "./commands/name.js";
import { openCommand } from "./commands/open.js";
import { promptHookCommand } from "./commands/prompt-hook.js";
import { runsCommand } from "./commands/runs.js";
import { statusCommand } from "./commands/status.js";
import { stopHookCommand } from "./commands/stop-hook.js";
import { summarizeCommand } from "./commands/summarize.js";
import { syncCommand } from "./commands/sync.js";
import { watchCommand } from "./commands/watch.js";

const main = async (): Promise<void> => {
  const program = new Command();
  program
    .name("claude-sessions")
    .description("Sync, search, and re-fork your Claude Code sessions.")
    .version("0.0.0");

  program
    .command("init")
    .description("Ensure the CLI is authenticated and the watcher daemon is running.")
    .option("--server <url>", "server URL", "http://localhost:3000")
    .action(async (opts: { server: string }) => {
      const code = await initCommand({ serverUrl: opts.server });
      process.exit(code);
    });

  program
    .command("ensure")
    .description("Verify auth + watcher are up (SessionStart hook entry point). Never blocks.")
    .option("--server <url>", "server URL", "http://localhost:3000")
    .action(async (opts: { server: string }) => {
      const code = await ensureCommand({ serverUrl: opts.server });
      process.exit(code);
    });

  program
    .command("login")
    .description("Authenticate via the dashboard and pair the CLI.")
    .option("--server <url>", "server URL", "http://localhost:3000")
    .action(async (opts: { server: string }) => {
      const code = await loginCommand({ serverUrl: opts.server });
      process.exit(code);
    });

  program
    .command("logout")
    .description("Stop the watcher and clear stored credentials.")
    .action(async () => {
      const code = await logoutCommand();
      process.exit(code);
    });

  program
    .command("logs")
    .description("Show recent watcher logs.")
    .option("-f, --follow", "stream new log lines as they arrive", false)
    .option("-n, --lines <n>", "number of lines to show", "200")
    .action(async (opts: { follow: boolean; lines: string }) => {
      const code = await logsCommand({
        follow: opts.follow,
        lines: Number.parseInt(opts.lines, 10) || 200,
      });
      process.exit(code);
    });

  program
    .command("enable [path]")
    .description("Watch the repo at <path> (defaults to cwd).")
    .action(async (path?: string) => {
      const client = buildClient();
      const code = await enableCommand({
        ...(path !== undefined ? { path } : {}),
        client,
      });
      process.exit(code);
    });

  program
    .command("disable [path]")
    .description("Stop watching a repo (defaults to cwd).")
    .option("--purge", "delete all events for this repo from the cloud", false)
    .action(async (path: string | undefined, opts: { purge: boolean }) => {
      const client = buildClient();
      const code = await disableCommand({
        ...(path !== undefined ? { path } : {}),
        purge: opts.purge,
        client,
      });
      process.exit(code);
    });

  program
    .command("status")
    .description("Show watched repos + last-sync timestamps.")
    .action(() => {
      const r = statusCommand();
      process.exit(r.exit);
    });

  program
    .command("config [args...]")
    .description(
      "Read or toggle persistent settings: config set <key> <value> | get <key> | list. " +
        "Keys: summary.enabled, learnings.enabled.",
    )
    .action(async (args: string[]) => {
      const code = await configCommand(args ?? []);
      process.exit(code);
    });

  program
    .command("sync")
    .description("One-shot catch-up: ingest any pending events for watched repos.")
    .option("--full-scan", "Re-read every JSONL from byte 0 (server dedupes by event_uuid)")
    .option(
      "--verify",
      "Reconcile local vs server event counts and re-push any missing (incl. disabled repos)",
    )
    .action(async (opts: { fullScan?: boolean; verify?: boolean }) => {
      const client = buildClient();
      const code = await syncCommand({
        client,
        fullScan: opts.fullScan === true,
        verify: opts.verify === true,
      });
      process.exit(code);
    });

  program
    .command("artifacts <session-id>")
    .description("Push the files an agent created/edited during a session to the server.")
    .option(
      "--file <path>",
      "push this file (repeatable); replaces auto-derivation",
      (val: string, acc: string[]) => {
        acc.push(val);
        return acc;
      },
      [] as string[],
    )
    .option(
      "--glob <pattern>",
      "push files matching this glob (repeatable); replaces auto-derivation",
      (val: string, acc: string[]) => {
        acc.push(val);
        return acc;
      },
      [] as string[],
    )
    .option("--dry-run", "print the resolved file list and exit without uploading", false)
    .action(
      async (sessionId: string, opts: { file: string[]; glob: string[]; dryRun: boolean }) => {
        const client = buildClient();
        const code = await artifactsCommand({
          sessionId,
          client,
          files: opts.file,
          globs: opts.glob,
          dryRun: opts.dryRun,
        });
        process.exit(code);
      },
    );

  program
    .command("watch")
    .description("Long-running watcher. Tails JSONL files and uploads new events.")
    .action(async () => {
      const client = buildClient();
      await watchCommand({ client });
    });

  program
    .command("summarize [session-id]")
    .description("Summarize a session by id, the current session, or all enabled-repo sessions.")
    .option("--all", "summarize every discovered session", false)
    .option("--current", "target the active session for the current directory", false)
    .option(
      "--from-agent",
      "read an agent-authored summary (JSON) from stdin instead of claude -p",
      false,
    )
    .option(
      "--provisional",
      "mark the agent summary as a provisional first-prompt title (model=heuristic)",
      false,
    )
    .option("--force", "bypass watermark/status gate", false)
    .option("--since <iso>", "only include sessions started at or after this ISO-8601 timestamp")
    .option("--yes", "skip the confirmation prompt", false)
    .action(
      async (
        sessionId: string | undefined,
        opts: {
          all: boolean;
          current: boolean;
          fromAgent: boolean;
          provisional: boolean;
          force: boolean;
          since?: string;
          yes: boolean;
        },
      ) => {
        const client = buildClient();
        const code = await summarizeCommand({
          client,
          ...(sessionId !== undefined ? { sessionId } : {}),
          all: opts.all,
          current: opts.current,
          fromAgent: opts.fromAgent,
          provisional: opts.provisional,
          force: opts.force,
          ...(opts.since !== undefined ? { since: opts.since } : {}),
          yes: opts.yes,
        });
        process.exit(code);
      },
    );

  program
    .command("fork <session-id>")
    .description("Fork a session at an event uuid into a local resumable JSONL.")
    .requiredOption("--until <event-uuid>", "event uuid to truncate at")
    .option("--cwd <path>", "local cwd for the new transcript")
    .action(async (sessionId: string, opts: { until: string; cwd?: string }) => {
      const client = buildClient();
      const code = await forkCommand({
        sessionId,
        until: opts.until,
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        client,
      });
      process.exit(code);
    });

  program
    .command("name <session-id> [name]")
    .description("Set or clear the display name for a session. Pass no name to clear.")
    .action(async (sessionId: string, name?: string) => {
      const client = buildClient();
      const code = await nameCommand({
        sessionId,
        name: name ?? null,
        client,
      });
      process.exit(code);
    });

  program
    .command("runs")
    .description("Show summarization runs (claude -p invocations) with cost and token totals.")
    .option("--limit <n>", "max rows to list", "20")
    .option("--since <iso>", "only runs at or after this timestamp")
    .option("--since-days <n>", "filter to the last N days")
    .option("--status <s>", "filter by status (ok|failed)")
    .option("--session <id>", "filter to a single session")
    .option("--stats", "show only the aggregate, skip the row table", false)
    .action(
      async (opts: {
        limit?: string;
        since?: string;
        sinceDays?: string;
        status?: string;
        session?: string;
        stats?: boolean;
      }) => {
        const client = buildClient();
        const params: Parameters<typeof runsCommand>[0] = { client };
        if (opts.limit) params.limit = Number.parseInt(opts.limit, 10);
        if (opts.since) params.since = opts.since;
        if (opts.sinceDays) params.sinceDays = Number.parseInt(opts.sinceDays, 10);
        if (opts.status === "ok" || opts.status === "failed") params.status = opts.status;
        if (opts.session) params.sessionId = opts.session;
        if (opts.stats) params.statsOnly = true;
        const r = await runsCommand(params);
        process.exit(r.exit);
      },
    );

  program
    .command("learnings <session-id>")
    .description("Show the per-session learnings (failure episodes) extracted for a session.")
    .option("--json", "print the raw learning records as JSON", false)
    .action(async (sessionId: string, opts: { json: boolean }) => {
      const client = buildClient();
      const code = await learningsCommand({ client, sessionId, json: opts.json });
      process.exit(code);
    });

  program
    .command("find <query...>")
    .description("Open the dashboard search page for the given query.")
    .action(async (queryParts: string[]) => {
      const code = await findCommand({ query: queryParts.join(" ") });
      process.exit(code);
    });

  program
    .command("open")
    .description("Open the dashboard URL in the default browser.")
    .action(async () => {
      const code = await openCommand();
      process.exit(code);
    });

  program
    .command("mcp")
    .description("Print the `claude mcp add` command to register the MCP server.")
    .action(async () => {
      const code = await mcpCommand();
      process.exit(code);
    });

  program
    .command("install-hooks")
    .description(
      "Install the global SessionStart + UserPromptSubmit + Stop hooks (ensure, provisional title, summary nudge) into settings.",
    )
    .action(() => {
      process.exit(installHooksCommand());
    });

  program
    .command("uninstall-hooks")
    .description(
      "Remove the claude-sessions SessionStart + UserPromptSubmit + Stop hooks from settings.",
    )
    .action(() => {
      process.exit(uninstallHooksCommand());
    });

  program
    .command("stop-hook", { hidden: true })
    .description("Stop-hook entry point: prompt the agent to author its session summary.")
    .action(async () => {
      const client = buildClient();
      process.exit(await stopHookCommand({ client }));
    });

  program
    .command("prompt-hook", { hidden: true })
    .description("UserPromptSubmit-hook entry point: prompt the agent for a provisional title.")
    .action(async () => {
      const client = buildClient();
      process.exit(await promptHookCommand({ client }));
    });

  await program.parseAsync(process.argv);
};

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
