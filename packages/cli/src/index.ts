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
  .option("--host <host>", "override repo host (default: resolved from each session's git repo)")
  .option("--owner <owner>", "override repo owner")
  .option("--owner-type <type>", "override owner type: user or org")
  .option("--repo-name <name>", "override repo name")
  .action((options: { host?: string; owner?: string; ownerType?: string; repoName?: string }) => {
    const { host, owner, ownerType, repoName } = options
    const repoOverride =
      host && owner && repoName
        ? {
            host,
            owner,
            ownerType: ownerType === "org" ? ("org" as const) : ("user" as const),
            repoName,
          }
        : undefined
    return watch({ repoOverride })
  })

program.parseAsync()
