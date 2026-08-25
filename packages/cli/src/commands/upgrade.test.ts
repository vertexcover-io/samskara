import { beforeEach, describe, expect, test, vi } from "vitest"
import { isNewer, RELEASES_API, upgradeCommand } from "./upgrade.js"

const release = (version: string) => ({
  tag_name: `v${version}`,
  assets: [
    { name: "checksums.txt", browser_download_url: "https://example.test/checksums.txt" },
    {
      name: `samskara-cli-${version}.tgz`,
      browser_download_url: `https://example.test/samskara-cli-${version}.tgz`,
    },
  ],
})

const jsonResponse = (body: unknown, ok = true) =>
  ({ ok, status: ok ? 200 : 404, json: async () => body }) as Response

const output = () => {
  const stdout: string[] = []
  const stderr: string[] = []
  return {
    stdout,
    stderr,
    writers: {
      stdout: { write: (text: string) => stdout.push(text) },
      stderr: { write: (text: string) => stderr.push(text) },
    },
  }
}

describe("isNewer", () => {
  test("compares each segment numerically rather than as text", () => {
    expect(isNewer("0.10.0", "0.9.0")).toBe(true)
    expect(isNewer("0.9.0", "0.10.0")).toBe(false)
    expect(isNewer("1.0.0", "0.99.99")).toBe(true)
  })

  test("the same version is not newer", () => {
    expect(isNewer("1.2.3", "1.2.3")).toBe(false)
  })

  test("a prerelease sorts below the release it leads to", () => {
    expect(isNewer("1.2.3", "1.2.3-rc.1")).toBe(true)
    expect(isNewer("1.2.3-rc.1", "1.2.3")).toBe(false)
  })

  test("a version that does not parse is never newer", () => {
    expect(isNewer("latest", "1.2.3")).toBe(false)
  })
})

describe("upgrade command", () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let install: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(jsonResponse(release("0.2.0")))
    install = vi.fn().mockResolvedValue(undefined)
  })

  const deps = (current: string) => ({
    fetch: fetchMock as unknown as typeof fetch,
    install,
    current,
  })

  test("installs the tarball attached to the newest release", async () => {
    const streams = output()

    const code = await upgradeCommand({}, { ...deps("0.1.0"), ...streams.writers })

    expect(code).toBe(0)
    expect(fetchMock).toHaveBeenCalledWith(RELEASES_API, expect.anything())
    expect(install).toHaveBeenCalledWith("https://example.test/samskara-cli-0.2.0.tgz")
    expect(streams.stdout.join("")).toContain("0.2.0")
    expect(streams.stdout.join("")).toContain("samskara restart")
  })

  test("an already-current CLI installs nothing", async () => {
    const streams = output()

    const code = await upgradeCommand({}, { ...deps("0.2.0"), ...streams.writers })

    expect(code).toBe(0)
    expect(install).not.toHaveBeenCalled()
    expect(streams.stdout.join("")).toMatch(/latest/i)
  })

  test("a newer local build than the newest release installs nothing", async () => {
    const streams = output()

    const code = await upgradeCommand({}, { ...deps("0.3.0"), ...streams.writers })

    expect(code).toBe(0)
    expect(install).not.toHaveBeenCalled()
  })

  test("--check reports the newer release without installing it", async () => {
    const streams = output()

    const code = await upgradeCommand({ check: true }, { ...deps("0.1.0"), ...streams.writers })

    expect(code).toBe(0)
    expect(install).not.toHaveBeenCalled()
    expect(streams.stdout.join("")).toContain("0.2.0")
    expect(streams.stdout.join("")).toContain("samskara upgrade")
  })

  test("a release with no tarball fails rather than installing something else", async () => {
    const streams = output()
    fetchMock.mockResolvedValue(
      jsonResponse({
        tag_name: "v0.2.0",
        assets: [{ name: "notes.txt", browser_download_url: "x" }],
      }),
    )

    const code = await upgradeCommand({}, { ...deps("0.1.0"), ...streams.writers })

    expect(code).toBe(1)
    expect(install).not.toHaveBeenCalled()
    expect(streams.stderr.join("")).toMatch(/tarball/i)
  })

  test("a failed release lookup reports the status and exits non-zero", async () => {
    const streams = output()
    fetchMock.mockResolvedValue(jsonResponse({}, false))

    const code = await upgradeCommand({}, { ...deps("0.1.0"), ...streams.writers })

    expect(code).toBe(1)
    expect(streams.stderr.join("")).toContain("404")
  })

  test("an unreachable GitHub reports the error and exits non-zero", async () => {
    const streams = output()
    fetchMock.mockRejectedValue(new Error("getaddrinfo ENOTFOUND api.github.com"))

    const code = await upgradeCommand({}, { ...deps("0.1.0"), ...streams.writers })

    expect(code).toBe(1)
    expect(streams.stderr.join("")).toContain("ENOTFOUND")
  })

  test("a failed install reports the error and exits non-zero", async () => {
    const streams = output()
    install.mockRejectedValue(new Error("EACCES: permission denied"))

    const code = await upgradeCommand({}, { ...deps("0.1.0"), ...streams.writers })

    expect(code).toBe(1)
    expect(streams.stderr.join("")).toContain("EACCES")
  })
})
