#!/usr/bin/env node
import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { Command } from "commander"
import { disableCommand } from "./commands/disable.js"
import { enableCommand } from "./commands/enable.js"
import { ensureCommand } from "./commands/ensure.js"
import { initCommand } from "./commands/init.js"
import { installHooksCommand, uninstallHooksCommand } from "./commands/install-hooks.js"
import { learnCommand } from "./commands/learn.js"
import { logoutCommand } from "./commands/logout.js"
import { logsCommand } from "./commands/logs.js"
import { reassignCommand } from "./commands/reassign.js"
import { replayCommand } from "./commands/replay.js"
import { restartCommand } from "./commands/restart.js"
import { reviewCommand } from "./commands/review.js"
import { type SearchOptions, searchCommand } from "./commands/search.js"
import { statusCommand } from "./commands/status.js"
import { upgradeCommand } from "./commands/upgrade.js"
import { watchCommand } from "./commands/watch.js"
import { readToken } from "./config/credentials.js"
import { startWatcherDaemon, stopWatcherDaemon } from "./config/daemon.js"
import { artifactQueuePath, artifactStatePath, statePath } from "./config/paths.js"
import { apiBase } from "./config.js"
import { login } from "./login.js"
import { cliVersion } from "./version.js"

/** Compare real paths: a global install invokes the bin through a symlink, and Node keeps that
 * symlink in `argv[1]` while `import.meta.url` already points at the resolved file. */
export const isEntrypoint = (argv1: string | undefined, moduleUrl: string): boolean => {
  if (argv1 === undefined) return false
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl))
  } catch {
    return false
  }
}

const isMain = isEntrypoint(process.argv[1], import.meta.url)

const program = new Command()

program
  .name("samskara")
  .description("Capture and search AI coding-agent session logs")
  .version(cliVersion)
  .option("--verbose", "enable debug logging")

program
  .command("init")
  .description("Choose a server, authenticate, install the SessionStart hook, start the watcher")
  .option("--server <url>", "Samskara API URL (default: http://localhost:3000)")
  .option("--web <url>", "Samskara web URL (default: http://localhost:8000)")
  .action(async (options: { server?: string; web?: string }) => {
    process.exitCode = await initCommand({
      ...(options.server === undefined ? {} : { server: options.server }),
      ...(options.web === undefined ? {} : { web: options.web }),
    })
  })

program
  .command("login")
  .description("Pair the CLI with a web session and store an aud:cli token")
  .option("--code <code>", "pairing code from the web UI")
  .action(async (options: { code?: string }) => {
    process.exitCode = await login(options)
  })

program
  .command("logout")
  .description("Stop the watcher and remove stored CLI credentials")
  .action(async () => {
    process.exitCode = await logoutCommand()
  })

program
  .command("replay <sessionId>")
  .description(
    "Re-capture a session from scratch: delete it server-side and locally, then re-ingest",
  )
  .action(async (sessionId: string) => {
    process.exitCode = await replayCommand(sessionId, {
      apiBase: apiBase(),
      token: await readToken(),
      fetch: globalThis.fetch,
      paths: {
        state: statePath(),
        artifacts: artifactStatePath(),
        queue: artifactQueuePath(),
      },
      stopWatcher: stopWatcherDaemon,
      startWatcher: startWatcherDaemon,
    })
  })

program
  .command("enable [path]")
  .description("Enable capture for a folder (defaults to cwd)")
  .option("--all", "Also capture sessions recorded before enabling")
  .option("--sync-from <date>", "Only capture sessions started after this date")
  .action(async (path: string | undefined, flags: { all?: boolean; syncFrom?: string }) => {
    process.exitCode = await enableCommand({
      ...(path === undefined ? {} : { path }),
      ...(flags.all === true ? { all: true } : {}),
      ...(flags.syncFrom === undefined ? {} : { syncFrom: flags.syncFrom }),
    })
  })

program
  .command("disable [path]")
  .description("Disable capture for a folder (defaults to cwd)")
  .action(async (path?: string) => {
    process.exitCode = await disableCommand(path === undefined ? {} : { path })
  })

program
  .command("reassign [path]")
  .description("Move a folder's sessions to a different project on the server (defaults to cwd)")
  .option("--to <projectId>", "destination project id, instead of picking from a list")
  .option("--all-sessions", "move everyone's sessions, not only your own (needs admin)")
  .option("-y, --yes", "skip the confirmation prompt")
  .action(
    async (
      path: string | undefined,
      flags: { to?: string; allSessions?: boolean; yes?: boolean },
    ) => {
      process.exitCode = await reassignCommand({
        ...(path === undefined ? {} : { path }),
        ...(flags.to === undefined ? {} : { to: flags.to }),
        ...(flags.allSessions === true ? { allSessions: true } : {}),
        ...(flags.yes === true ? { yes: true } : {}),
      })
    },
  )

program
  .command("review [sessionId]")
  .description("Analyze a session (default: the most recent) for outcome, friction and learnings")
  .option("--recent <n>", "review the N most recent sessions instead of one")
  .option("--ai", "run the harness AI review and wait for its verdict")
  .option("--json", "with --ai: print the raw AI review JSON")
  .option("--timeout <ms>", "with --ai: how long to wait for the verdict, in ms (default 600000)")
  .action(
    async (
      sessionId: string | undefined,
      options: { recent?: string; ai?: boolean; json?: boolean; timeout?: string },
    ) => {
      const recent = options.recent === undefined ? undefined : Number.parseInt(options.recent, 10)
      const timeout =
        options.timeout === undefined ? undefined : Number.parseInt(options.timeout, 10)
      process.exitCode = await reviewCommand(sessionId === undefined ? undefined : sessionId, {
        ...(Number.isFinite(recent) ? { recent } : {}),
        ...(options.ai === true ? { ai: true } : {}),
        ...(options.json === true ? { json: true } : {}),
        ...(Number.isFinite(timeout) ? { timeoutMs: timeout } : {}),
      })
    },
  )

program
  .command("learn")
  .description("List accepted learnings, or write them into this repo with --write")
  .option("--project <name>", "project name, slug, or id to learn from")
  .option("--audience <who>", "agent or human")
  .option("--status <state>", "candidate, accepted or superseded (default accepted)")
  .option("--write", "write LEARNINGS.md and .harness/knowledge/ into this repo")
  .option("--out <dir>", "directory to write into (default: current directory)")
  .action(
    async (options: {
      project?: string
      audience?: string
      status?: string
      write?: boolean
      out?: string
    }) => {
      process.exitCode = await learnCommand(options)
    },
  )

program
  .command("status")
  .description("Show registered projects, sync timestamps, and watcher status")
  .action(async () => {
    process.exitCode = await statusCommand()
  })

program
  .command("watch")
  .description("Start the capture daemon in the background (logs to watch.log)")
  .option("--foreground", "run the capture loop in this process instead of detaching")
  .action(async (options: { foreground?: boolean }) => {
    process.exitCode = await watchCommand({
      foreground: Boolean(options.foreground),
      verbose: Boolean(program.opts<{ verbose?: boolean }>().verbose),
    })
  })

program
  .command("search [query]")
  .description("Search captured sessions and print the web URL for each one")
  .option("--project <name>", "project name or id")
  .option("--user <login>", "GitHub login of the person who ran the session")
  .option("--repo <name>", "repository as owner/name, its bare name, or its id")
  .option("--branch <name>", "git branch")
  .option("--pr <number>", "pull request number")
  .option("--commit <sha>", "commit sha, or at least 7 characters of one")
  .option("--ai-review <state>", "done or missing: whether the AI analysis has run")
  .option("--range <range>", "all, hour, today, week, month or custom")
  .option("--from <date>", "start of a custom range, as YYYY-MM-DD")
  .option("--to <date>", "end of a custom range, as YYYY-MM-DD")
  .option("--tz <zone>", "IANA time zone for today and custom ranges")
  .option("--sort <sort>", "relevance, recent, oldest, tokens or project")
  .option("--page <number>", "which page of results to show")
  .option("--limit <number>", "results per page, up to 100")
  .option("--here", "take project, repo and branch from the current folder")
  .option("--first", "keep only the top result")
  .option("--url", "print only session URLs, one per line")
  .option("--json", "print the results as JSON")
  .option("--open", "open the top result in the browser")
  .action(async (query: string | undefined, flags: SearchOptions) => {
    process.exitCode = await searchCommand(
      { ...flags, ...(query === undefined ? {} : { query }) },
      { fetch: globalThis.fetch },
    )
  })

program
  .command("restart")
  .description("Stop the capture watcher and start a fresh one (requires being logged in)")
  .action(async () => {
    process.exitCode = await restartCommand()
  })

program
  .command("upgrade")
  .description("Install the newest release from GitHub over this one")
  .option("--check", "only report whether a newer release exists")
  .action(async (options: { check?: boolean }) => {
    process.exitCode = await upgradeCommand({ check: Boolean(options.check) })
  })

program
  .command("logs")
  .description("Pretty-print the watcher log (use -f to stream new lines)")
  .option("-f, --follow", "keep streaming as new lines are written")
  .option("--no-color", "disable colored output")
  .action(async (options: { follow?: boolean; color?: boolean }) => {
    process.exitCode = await logsCommand({
      follow: Boolean(options.follow),
      colorize: options.color !== false,
    })
  })

program
  .command("install-hooks")
  .description("Install the Claude Code SessionStart hook")
  .action(() => {
    process.exitCode = installHooksCommand()
  })

program
  .command("uninstall-hooks")
  .description("Remove the Samskara SessionStart hook")
  .action(() => {
    process.exitCode = uninstallHooksCommand()
  })

program
  .command("ensure", { hidden: true })
  .description("SessionStart hook entry point")
  .action(async () => {
    process.exitCode = await ensureCommand()
  })

if (isMain) void program.parseAsync()
