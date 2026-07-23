#!/usr/bin/env node
import { Command } from "commander"
import { login } from "./login.js"
import { watch } from "./watcher/index.js"

const program = new Command()

program
  .name("samskara")
  .description("Capture and search AI coding-agent session logs")
  .version("0.0.0")

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
    return watch({ projectOverride })
  })

program.parseAsync()
