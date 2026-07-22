import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { expect, test } from "vitest"

const entry = fileURLToPath(new URL("./index.ts", import.meta.url))

test("samskara --version prints the version and exits 0", () => {
  const out = execFileSync("bun", [entry, "--version"], { encoding: "utf8" })
  expect(out.trim()).toBe("0.0.0")
})
