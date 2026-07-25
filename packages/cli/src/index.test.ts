import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { resolveLevel } from "@samskara/core"
import { expect, test } from "vitest"
import { cliLogger } from "./index.js"

const entry = fileURLToPath(new URL("./index.ts", import.meta.url))

test("samskara --version prints the version and exits 0", () => {
  const out = execFileSync("bun", [entry, "--version"], { encoding: "utf8" })
  expect(out.trim()).toBe("0.0.0")
})

test("capture lifecycle commands are exposed while ensure remains hidden", () => {
  const out = execFileSync("bun", [entry, "--help"], { encoding: "utf8" })

  for (const command of [
    "init",
    "login",
    "logout",
    "enable",
    "disable",
    "status",
    "watch",
    "install-hooks",
    "uninstall-hooks",
  ]) {
    expect(out).toContain(command)
  }
  expect(out).not.toContain("ensure [options]")
})

test("S22: cliLogger(true) resolves level debug regardless of env", () => {
  expect(cliLogger(true).level).toBe("debug")
})

test("S22: cliLogger(false) resolves the level per env (LOG_LEVEL/NODE_ENV)", () => {
  expect(cliLogger(false).level).toBe(resolveLevel(process.env))
})

test("S22: both verbose and default loggers carry service samskara-cli", () => {
  expect(cliLogger(true).bindings().service).toBe("samskara-cli")
  expect(cliLogger(false).bindings().service).toBe("samskara-cli")
})
