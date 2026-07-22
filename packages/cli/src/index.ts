#!/usr/bin/env node
import { Command } from "commander"

const program = new Command()

program
  .name("samskara")
  .description("Capture and search AI coding-agent session logs")
  .version("0.0.0")

// TODO(milestone): file watcher + resume/ingest commands

program.parse()
