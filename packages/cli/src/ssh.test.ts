import { describe, expect, test } from "vitest"
import { canonicalSshHost } from "./ssh.js"

describe("canonicalSshHost", () => {
  test("a host that already carries a dot is never put through ssh config, so GitHub's own `Host github.com` / `Hostname ssh.github.com` workaround cannot rewrite a correct host", async () => {
    await expect(canonicalSshHost("github.com")).resolves.toEqual({
      host: "github.com",
      certain: true,
    })
  })

  test("a host ssh would read as an option is returned unresolved, so a remote cannot hand ssh a config file of its own choosing", async () => {
    await expect(canonicalSshHost("-F/tmp/evil")).resolves.toEqual({
      host: "-F/tmp/evil",
      certain: true,
    })
  })

  test("a name no ssh config mentions answers itself rather than empty, so a machine without the alias keeps the host git recorded", async () => {
    await expect(canonicalSshHost("samskara-no-such-alias")).resolves.toEqual({
      host: "samskara-no-such-alias",
      certain: true,
    })
  })
})
