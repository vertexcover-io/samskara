import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { expect, test } from "vitest"

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
      "logs",
      "install-hooks",
      "uninstall-hooks",
    ]),
  )
  expect(listed).not.toContain("ensure")
})
