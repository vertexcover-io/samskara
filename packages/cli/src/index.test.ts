import { execFileSync } from "node:child_process"
import { mkdtempSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "vitest"
import { isEntrypoint } from "./index.js"

const entry = fileURLToPath(new URL("./index.ts", import.meta.url))

test("samskara --version prints the version and exits 0", () => {
  const out = execFileSync("bun", [entry, "--version"], { encoding: "utf8" })
  expect(out.trim()).toBe("0.0.0")
})

test("capture lifecycle commands are exposed while ensure remains hidden", () => {
  const out = execFileSync("bun", [entry, "--help"], { encoding: "utf8" })
  const listed = out
    .slice(out.indexOf("Commands:"))
    .split("\n")
    .map((line) => line.trim().split(/[\s[]/)[0])
    .filter(Boolean)

  expect(listed).toEqual(
    expect.arrayContaining([
      "init",
      "login",
      "logout",
      "enable",
      "disable",
      "status",
      "watch",
      "restart",
      "logs",
      "install-hooks",
      "uninstall-hooks",
    ]),
  )
  expect(listed).not.toContain("ensure")
})

test("a symlinked bin counts as the entrypoint, as a global install invokes it", () => {
  const dir = mkdtempSync(join(tmpdir(), "samskara-bin-"))
  const link = join(dir, "samskara")
  symlinkSync(entry, link)
  expect(isEntrypoint(link, import.meta.url.replace("index.test.ts", "index.ts"))).toBe(true)
})

test("an unrelated argv[1] is not the entrypoint", () => {
  expect(isEntrypoint(entry.replace("index.ts", "login.ts"), import.meta.url)).toBe(false)
  expect(isEntrypoint(undefined, import.meta.url)).toBe(false)
  expect(isEntrypoint("/nope/does-not-exist", import.meta.url)).toBe(false)
})
