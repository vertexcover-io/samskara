#!/usr/bin/env node
import { fileURLToPath } from "node:url"
import { createLogger } from "@samskara/core"
import { Command } from "commander"
import type pino from "pino"
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
  .command("login")
  .description("Pair the CLI with a web session and store an aud:cli token")
  .option("--code <code>", "pairing code from the web UI")
  .action((options: { code?: string }) => login(options))

program
  .command("watch")
  .description("Run the capture daemon: discover and ingest Claude session files")
  .option("--project-name <name>", "override project name (default: resolved from the session dir)")
  .option("--project-slug <slug>", "override project slug (default: resolved from the session dir)")
  .action((options: { projectName?: string; projectSlug?: string }) => {
    const { projectName, projectSlug } = options
    const projectOverride =
      projectName && projectSlug ? { name: projectName, slug: projectSlug } : undefined
    const log = cliLogger(Boolean(program.opts().verbose))
    return watch({ projectOverride, log })
  })

if (isMain) program.parseAsync()
