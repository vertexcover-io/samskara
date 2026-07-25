#!/usr/bin/env node
import { fileURLToPath } from "node:url"
import { createLogger } from "@samskara/core"
import { Command } from "commander"
import type pino from "pino"
import { disableCommand } from "./commands/disable.js"
import { enableCommand } from "./commands/enable.js"
import { ensureCommand } from "./commands/ensure.js"
import { initCommand } from "./commands/init.js"
import { installHooksCommand, uninstallHooksCommand } from "./commands/install-hooks.js"
import { logoutCommand } from "./commands/logout.js"
import { statusCommand } from "./commands/status.js"
import { login } from "./login.js"
import { watch } from "./watcher/index.js"

const isMain = process.argv[1] === fileURLToPath(import.meta.url)

export const cliLogger = (verbose: boolean): pino.Logger =>
  createLogger({ service: "samskara-cli" }, verbose ? { level: "debug" } : {})

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
  .command("enable [path]")
  .description("Enable capture for a folder (defaults to cwd)")
  .action(async (path?: string) => {
    process.exitCode = await enableCommand(path === undefined ? {} : { path })
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
  .description("Run the capture daemon: discover and ingest Claude session files")
  .option("--project-name <name>", "override project name (default: resolved from the session dir)")
  .option("--project-slug <slug>", "override project slug (default: resolved from the session dir)")
  .action((options: { projectName?: string; projectSlug?: string }) => {
    const { projectName, projectSlug } = options
    const projectOverride =
      projectName && projectSlug ? { name: projectName, slug: projectSlug } : undefined
    const log = cliLogger(Boolean(program.opts<{ verbose?: boolean }>().verbose))
    return watch({ projectOverride, log })
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
