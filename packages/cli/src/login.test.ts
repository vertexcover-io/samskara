import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test, vi } from "vitest"
import { checkToken, login } from "./login.js"

const originalHome = process.env.SAMSKARA_HOME

afterEach(() => {
  process.env.SAMSKARA_HOME = originalHome
  vi.unstubAllGlobals()
})

type StubOptions = {
  readonly token?: string
  readonly verifyStatus?: number
  readonly verifyBody?: unknown
}

const pairingFetch = (options: StubOptions = {}) => {
  const impl = async (input: Parameters<typeof globalThis.fetch>[0]): Promise<Response> => {
    const url = String(input)
    if (url.endsWith("/api/auth/cli-exchange")) {
      return new Response(JSON.stringify({ token: options.token ?? "cli-token" }), { status: 200 })
    }
    if (url.endsWith("/api/auth/me")) {
      const status = options.verifyStatus ?? 200
      const body = options.verifyBody ?? {
        id: "user-1",
        githubLogin: "kgritesh",
        email: null,
        name: null,
        avatarUrl: null,
        isSuperAdmin: false,
      }
      return new Response(JSON.stringify(body), { status })
    }
    throw new Error(`unexpected request to ${url}`)
  }
  vi.stubGlobal("fetch", vi.fn(impl))
}

describe("login command", () => {
  test("REQ-017,REQ-033,EDGE-016: exchanges a code and stores the token under SAMSKARA_HOME at 0600", async () => {
    const home = await mkdtemp(join(tmpdir(), "samskara-login-"))
    process.env.SAMSKARA_HOME = home
    await writeFile(join(home, "projects.json"), '{"version":1,"projects":{}}', "utf8")
    await writeFile(join(home, "watch.log"), "watcher ready\n", "utf8")
    await writeFile(join(home, "token"), "old-token", { mode: 0o644 })
    const output: string[] = []

    pairingFetch()

    const code = await login({
      code: "PAIR-CODE",
      stdout: { write: (text) => output.push(text) },
      stderr: { write: (text) => output.push(text) },
    })

    const path = join(home, "token")
    expect(code).toBe(0)
    expect(await readFile(path, "utf8")).toBe("cli-token")
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await readFile(join(home, "projects.json"), "utf8")).not.toContain("cli-token")
    expect(await readFile(join(home, "watch.log"), "utf8")).not.toContain("cli-token")
    expect(output.join("")).toContain(
      `Logged in as kgritesh. The access token was saved to ${path}.`,
    )
  })

  test("REQ-017: reports pairing failures without writing credentials", async () => {
    const home = await mkdtemp(join(tmpdir(), "samskara-login-fail-"))
    process.env.SAMSKARA_HOME = home
    const errors: string[] = []

    vi.stubGlobal(
      "fetch",
      async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
    )

    const code = await login({
      code: "BAD",
      stderr: { write: (text) => errors.push(text) },
    })

    expect(code).toBe(1)
    await expect(readFile(join(home, "token"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    expect(errors.join("")).toContain("The server rejected this pairing code")
    expect(errors.join("")).toContain("already been used")
    expect(errors.join("")).not.toContain("expires")
    expect(errors.join("")).toContain("Pair the CLI")
  })

  test("a token the server will not accept is reported, not stored", async () => {
    const home = await mkdtemp(join(tmpdir(), "samskara-login-unusable-"))
    process.env.SAMSKARA_HOME = home
    const errors: string[] = []

    pairingFetch({ verifyStatus: 401 })

    const code = await login({
      code: "PAIR-CODE",
      stderr: { write: (text) => errors.push(text) },
    })

    expect(code).toBe(1)
    await expect(readFile(join(home, "token"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    expect(errors.join("")).toContain("The server rejected the token received from pairing")
  })

  test("an identity response failing the schema is rejected before storing", async () => {
    const home = await mkdtemp(join(tmpdir(), "samskara-login-badshape-"))
    process.env.SAMSKARA_HOME = home
    const errors: string[] = []

    pairingFetch({ verifyBody: { id: "user-1" } })

    const code = await login({
      code: "PAIR-CODE",
      stderr: { write: (text) => errors.push(text) },
    })

    expect(code).toBe(1)
    await expect(readFile(join(home, "token"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    expect(errors.join("")).toContain("format this CLI does not recognize")
  })

  test("an empty-string token fails the schema rather than being stored", async () => {
    const home = await mkdtemp(join(tmpdir(), "samskara-login-emptytoken-"))
    process.env.SAMSKARA_HOME = home
    const errors: string[] = []

    pairingFetch({ token: "" })

    const code = await login({
      code: "PAIR-CODE",
      stderr: { write: (text) => errors.push(text) },
    })

    expect(code).toBe(1)
    await expect(readFile(join(home, "token"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    expect(errors.join("")).toContain("did not return a usable token")
  })

  test("checkToken gives up on a server that never answers after its 3s ceiling, rather than hanging the hook", async () => {
    const realTimeout = AbortSignal.timeout.bind(AbortSignal)
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => realTimeout(50))
    vi.stubGlobal("fetch", (_url: string, init?: RequestInit) => {
      // A blackholed connection: only the caller's own deadline ends this.
      const signal = init?.signal
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")))
      })
    })

    await expect(checkToken("stale")).resolves.toBe("unreachable")
    expect(timeout).toHaveBeenCalledWith(3_000)
  }, 1_000)

  test("a missing code tells the user where to get one", async () => {
    process.env.SAMSKARA_HOME = await mkdtemp(join(tmpdir(), "samskara-login-nocode-"))
    const errors: string[] = []

    const code = await login({
      code: "",
      promptForCode: async () => "",
      stderr: { write: (text) => errors.push(text) },
    })

    expect(code).toBe(1)
    expect(errors.join("")).toContain("http://localhost:8000")
    expect(errors.join("")).toContain("Generate code")
  })
})
