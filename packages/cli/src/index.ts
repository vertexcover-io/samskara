#!/usr/bin/env node
import { fileURLToPath } from "node:url"
import { Command } from "commander"
import { disableCommand } from "./commands/disable.js"
import { enableCommand } from "./commands/enable.js"
import { ensureCommand } from "./commands/ensure.js"
import { initCommand } from "./commands/init.js"
import { installHooksCommand, uninstallHooksCommand } from "./commands/install-hooks.js"
import { logoutCommand } from "./commands/logout.js"
import { logsCommand } from "./commands/logs.js"
import { replayCommand } from "./commands/replay.js"
import { statusCommand } from "./commands/status.js"
import { watchCommand } from "./commands/watch.js"
import { apiBase } from "./config.js"
import { readToken } from "./config/credentials.js"
import { startWatcherDaemon, stopWatcherDaemon } from "./config/daemon.js"
import { artifactQueuePath, artifactStatePath, statePath } from "./config/paths.js"
import { login } from "./login.js"

const isMain = process.argv[1] === fileURLToPath(import.meta.url)

const program = new Command()

program
  .name("samskara")
  .description("Capture and search AI coding-agent session logs")
  .version("0.0.0")
  .option("--verbose", "enable debug logging")

program
  .command("init")
  .description("Authenticate, install the SessionStart hook, and start the watcher")
  .action(async () => {
    process.exitCode = await initCommand()
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
      apiBase,
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
  .command("status")
  .description("Show registered projects, sync timestamps, and watcher status")
  .action(async () => {
    process.exitCode = await statusCommand()
  })

program
  .command("watch")
  .description("Start the capture daemon in the background (logs to watch.log)")
  .option("--foreground", "run the capture loop in this process instead of detaching")
  .option("--project-name <name>", "override project name (default: resolved from the session dir)")
  .option("--project-slug <slug>", "override project slug (default: resolved from the session dir)")
  .action(async (options: { foreground?: boolean; projectName?: string; projectSlug?: string }) => {
    const { projectName, projectSlug } = options
    const projectOverride =
      projectName && projectSlug ? { name: projectName, slug: projectSlug } : undefined
    process.exitCode = await watchCommand({
      foreground: Boolean(options.foreground),
      verbose: Boolean(program.opts<{ verbose?: boolean }>().verbose),
      ...(projectOverride ? { projectOverride } : {}),
    })
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
