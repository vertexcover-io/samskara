import { describe, expect, test } from "vitest"
import { applyEnv, definesScript } from "./env-file.js"

describe("applyEnv", () => {
  test.each([
    [
      "rewrites an existing key in place, leaving comments and order alone",
      "# db\nDATABASE_URL=old\nJWT_SECRET=keep\n",
      { DATABASE_URL: "new" },
      "# db\nDATABASE_URL=new\nJWT_SECRET=keep\n",
    ],
    [
      "appends a key the file does not have yet",
      "JWT_SECRET=keep\n",
      { PORT: "3042" },
      "JWT_SECRET=keep\nPORT=3042\n",
    ],
    [
      "appends cleanly when the file has no trailing newline",
      "JWT_SECRET=keep",
      { PORT: "3042" },
      "JWT_SECRET=keep\nPORT=3042\n",
    ],
    [
      "leaves a key whose name merely contains the target alone",
      "MY_PORT=1\nPORT=2\n",
      { PORT: "3042" },
      "MY_PORT=1\nPORT=3042\n",
    ],
  ])("%s", (_case, text, values, expected) => {
    expect(applyEnv(text, values)).toBe(expected)
  })

  test("is idempotent", () => {
    const once = applyEnv("DATABASE_URL=old\n", { DATABASE_URL: "new" })
    expect(applyEnv(once, { DATABASE_URL: "new" })).toBe(once)
  })
})

describe("definesScript", () => {
  test.each([
    ["a script the worktree's package.json defines", '{"scripts":{"seed":"x"}}', true],
    ["a branch cut before the script existed", '{"scripts":{"test":"x"}}', false],
    ["a package.json with no scripts", "{}", false],
    ["a package.json that is null", "null", false],
  ])("reports %s", (_case, manifest, defined) => {
    expect(definesScript(manifest, "seed")).toBe(defined)
  })
})
