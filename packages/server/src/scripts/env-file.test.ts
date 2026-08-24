import { describe, expect, test } from "vitest"
import { applyEnv, definesScript } from "./env-file.js"

describe("applyEnv", () => {
  test("rewrites an existing key in place, leaving comments and order alone", () => {
    const text = "# db\nDATABASE_URL=old\nJWT_SECRET=keep\n"
    expect(applyEnv(text, { DATABASE_URL: "new" })).toBe(
      "# db\nDATABASE_URL=new\nJWT_SECRET=keep\n",
    )
  })

  test("appends a key the file does not have yet", () => {
    expect(applyEnv("JWT_SECRET=keep\n", { PORT: "3042" })).toBe("JWT_SECRET=keep\nPORT=3042\n")
  })

  test("appends cleanly when the file has no trailing newline", () => {
    expect(applyEnv("JWT_SECRET=keep", { PORT: "3042" })).toBe("JWT_SECRET=keep\nPORT=3042\n")
  })

  test("leaves a key whose name merely contains the target alone", () => {
    const text = "MY_PORT=1\nPORT=2\n"
    expect(applyEnv(text, { PORT: "3042" })).toBe("MY_PORT=1\nPORT=3042\n")
  })

  test("is idempotent", () => {
    const once = applyEnv("DATABASE_URL=old\n", { DATABASE_URL: "new" })
    expect(applyEnv(once, { DATABASE_URL: "new" })).toBe(once)
  })
})

describe("definesScript", () => {
  test("finds a script the worktree's package.json defines", () => {
    expect(definesScript('{"scripts":{"seed":"x"}}', "seed")).toBe(true)
  })

  test("reports missing for a branch cut before the script existed", () => {
    expect(definesScript('{"scripts":{"test":"x"}}', "seed")).toBe(false)
    expect(definesScript("{}", "seed")).toBe(false)
    expect(definesScript("null", "seed")).toBe(false)
  })
})
