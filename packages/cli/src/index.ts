#!/usr/bin/env node
import { Command } from "commander"
import { login } from "./login.js"

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

program.parseAsync()
