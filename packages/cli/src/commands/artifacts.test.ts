import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { ArtifactUploadPayload } from "@samskara/core"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { atomicWriteJson } from "../config/atomic.js"
import { projectsPath } from "../config/paths.js"
import { DEFAULT_API_URL } from "../config.js"
import { prepareUpload } from "../watcher/artifact-upload.js"
import {
  expandPaths,
  resolveInputs,
  type UploadArgs,
  type UploadDeps,
  uploadArtifactsCommand,
} from "./artifacts.js"

vi.mock("../watcher/artifact-upload.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../watcher/artifact-upload.js")>()
  return { ...actual, prepareUpload: vi.fn(actual.prepareUpload) }
})

const originalHome = process.env.SAMSKARA_HOME
let home = ""

beforeEach(async () => {
  // Canonical, because the command resolves symlinks before it compares paths and `/var` is a
  // symlink to `/private/var` on macOS -- an uncanonicalised fixture would not match its own files.
  home = await realpath(await mkdtemp(join(tmpdir(), "samskara-artifacts-cmd-")))
  process.env.SAMSKARA_HOME = home
})

afterEach(async () => {
  process.env.SAMSKARA_HOME = originalHome
  await rm(home, { recursive: true, force: true })
  const actual = await vi.importActual<typeof import("../watcher/artifact-upload.js")>(
    "../watcher/artifact-upload.js",
  )
  vi.mocked(prepareUpload).mockImplementation(actual.prepareUpload)
})

type Call = {
  readonly url: string
  readonly body: ArtifactUploadPayload
  readonly headers: Record<string, string>
}

/** A stub `fetch` that only ever answers `/api/artifacts`; a request to any other route throws,
 * so a stray call fails the test loudly instead of silently. */
const stubFetch = (respond: (call: Call, index: number) => Response) => {
  const calls: Call[] = []
  const fetch = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const href = String(url)
    if (!href.endsWith("/api/artifacts")) throw new Error(`unexpected request to ${href}`)
    const call: Call = {
      url: href,
      body: JSON.parse(String(init?.body)),
      headers: (init?.headers ?? {}) as Record<string, string>,
    }
    calls.push(call)
    return respond(call, calls.length - 1)
  }) as unknown as typeof globalThis.fetch
  return { fetch, calls }
}

const ok =
  (updated = false) =>
  (): Response =>
    new Response(JSON.stringify({ artifactId: "art-1", updated }), { status: 200 })

const baseArgs = (
  over: Partial<UploadArgs> & { readonly paths: readonly string[] },
): UploadArgs => ({
  sessionId: "sess-1",
  created: true,
  dryRun: false,
  ...over,
})

const io = () => {
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

const baseDeps = (
  fetch: typeof globalThis.fetch,
  writers: {
    readonly stdout: { write: (t: string) => unknown }
    readonly stderr: { write: (t: string) => unknown }
  },
  over: Partial<UploadDeps> = {},
): UploadDeps => ({
  apiBase: "http://test",
  token: "test-token",
  fetch,
  stdout: writers.stdout,
  stderr: writers.stderr,
  ...over,
})

const tempFile = async (relativePath: string, content: string | Buffer): Promise<string> => {
  const path = join(home, relativePath)
  await mkdir(join(path, ".."), { recursive: true })
  await writeFile(path, content)
  return path
}

/** Polls rather than counting ticks: the command does real disk I/O before the first upload, so
 * no fixed number of microtask hops says a stub has been reached. */
const waitUntil = async (check: () => boolean, timeoutMs = 2000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe("resolveInputs", () => {
  test("SC1: a file's relative path is derived against the base directory", () => {
    const resolved = resolveInputs(["/work/reports/out.html"], "/work")

    expect(resolved).toEqual([
      { absolutePath: "/work/reports/out.html", relativePath: "reports/out.html" },
    ])
  })

  test("SC2: a file outside the base directory is refused", () => {
    const resolved = resolveInputs(["/work/out.html", "/elsewhere/out.html"], "/work")

    expect(resolved).toEqual({ kind: "outsideBase", path: "/elsewhere/out.html" })
  })

  test("SC20 (regression): a path is resolved against the cwd, never against the base dir", () => {
    // Pins two bugs at once: `resolve(baseDir, path)` re-anchored the input to a directory
    // nothing had looked in, and made this refusal unreachable for every relative path.
    const resolved = resolveInputs(["out.html"], "/work")

    expect(resolved).toEqual({ kind: "outsideBase", path: resolve("out.html") })
    expect(resolve("out.html").startsWith("/work/")).toBe(false)
  })

  test("SC23 (regression): a name that merely opens with two dots is under the base dir", () => {
    // `relative()` answers `..report.html`, which a bare `startsWith("..")` reads as an escape.
    // Only a whole `..` segment walks upwards.
    const resolved = resolveInputs(["/work/..report.html"], "/work")

    expect(resolved).toEqual([
      { absolutePath: "/work/..report.html", relativePath: "..report.html" },
    ])
  })

  test("SC3: two inputs resolving to the same file under the base dir collide", () => {
    // Different strings, same real target once resolved -- exactly what a caller who typed a
    // redundant path segment would produce.
    const resolved = resolveInputs(["/work/shots/a.png", "/work/shots/nested/../a.png"], "/work")

    expect(resolved).toEqual({
      kind: "collision",
      relativePath: "shots/a.png",
      paths: ["/work/shots/a.png", "/work/shots/a.png"],
    })
  })
})

describe("expandPaths", () => {
  test("SC13: a directory contributes every file beneath it, in a stable order", async () => {
    const dir = join(home, "report")
    await mkdir(join(dir, "nested"), { recursive: true })
    await writeFile(join(dir, "top.md"), "top")
    await writeFile(join(dir, "nested", "a.md"), "a")
    await writeFile(join(dir, "nested", "b.md"), "b")

    const expected = [join(dir, "nested", "a.md"), join(dir, "nested", "b.md"), join(dir, "top.md")]
    expect(await expandPaths([dir])).toEqual(expected)
    expect(await expandPaths([dir])).toEqual(expected)
  })

  test("SC14: the walk skips dotfiles and dot-directories", async () => {
    const dir = join(home, "walked")
    await mkdir(join(dir, ".cache"), { recursive: true })
    await writeFile(join(dir, "report.html"), "report")
    await writeFile(join(dir, ".DS_Store"), "junk")
    await writeFile(join(dir, ".cache", "inside.txt"), "inside")

    expect(await expandPaths([dir])).toEqual([join(dir, "report.html")])
  })

  test("SC15: the walk skips files that look like credentials", async () => {
    const dir = join(home, "secrets")
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "report.html"), "report")
    await writeFile(join(dir, "credentials.json"), "{}")
    await writeFile(join(dir, "id_rsa"), "key")
    await writeFile(join(dir, "server.pem"), "cert")

    expect(await expandPaths([dir])).toEqual([join(dir, "report.html")])
  })

  test("SC22 (regression): a directory reached by symlink is walked at its real location", async () => {
    // The alias has no dot segment and no `.ssh`, so filtering the path the walk was reached by
    // let every file under a hidden directory through.
    const base = join(home, "base")
    await mkdir(join(base, ".ssh"), { recursive: true })
    await writeFile(join(base, ".ssh", "config"), "Host *")
    await symlink(join(base, ".ssh"), join(base, "public"))

    expect(await expandPaths([join(base, "public")])).toEqual([])
  })

  test("SC16: an explicitly named file is uploaded even when the walk would skip it", async () => {
    const dir = join(home, "envdir")
    await mkdir(dir, { recursive: true })
    const envPath = join(dir, ".env")
    await writeFile(envPath, "SECRET=1")

    expect(await expandPaths([envPath])).toEqual([envPath])
    expect(await expandPaths([dir])).toEqual([])
  })
})

describe("uploadArtifactsCommand", () => {
  test("SC1: with no --base-dir, resolution falls back to the current working directory", async () => {
    const path = await tempFile("reports/out.html", "<html></html>")
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(home)
    const { stdout, writers } = io()
    try {
      const code = await uploadArtifactsCommand(
        baseArgs({ paths: [path], dryRun: true }),
        baseDeps(
          (() => {
            throw new Error("dry run must not fetch")
          }) as unknown as typeof globalThis.fetch,
          writers,
        ),
      )
      expect(code).toBe(0)
      expect(stdout.join("")).toContain("reports/out.html")
    } finally {
      cwd.mockRestore()
    }
  })

  test("SC17: --dry-run walks a directory, lists every file, and uploads nothing", async () => {
    const dir = join(home, "preview")
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "a.md"), "a")
    await writeFile(join(dir, "b.md"), "b")
    await writeFile(join(dir, "c.md"), "c")
    const { fetch, calls } = stubFetch(ok())
    const { stdout, writers } = io()

    const code = await uploadArtifactsCommand(
      baseArgs({ baseDir: home, paths: [dir], dryRun: true }),
      baseDeps(fetch, writers),
    )

    expect(code).toBe(0)
    expect(calls).toHaveLength(0)
    const output = stdout.join("")
    expect(output).toContain("preview/a.md")
    expect(output).toContain("preview/b.md")
    expect(output).toContain("preview/c.md")
    expect(output).toContain("3 files")
  })

  test("SC18: --dry-run still fails on a collision, before any preview is printed", async () => {
    const { fetch, calls } = stubFetch(ok())
    const { stdout, writers } = io()

    const code = await uploadArtifactsCommand(
      baseArgs({
        baseDir: "/work",
        paths: ["/work/shots/a.png", "/work/shots/nested/../a.png"],
        dryRun: true,
      }),
      baseDeps(fetch, writers),
    )

    expect(code).toBe(1)
    expect(calls).toHaveLength(0)
    const output = stdout.join("")
    expect(output).toContain("shots/a.png")
    expect(output).not.toContain("would upload")
  })

  test("SC2: a path outside the base directory stops the run before anything uploads", async () => {
    const inside = await tempFile("inside.md", "inside")
    const { fetch, calls } = stubFetch(ok())
    const { stdout, writers } = io()

    const code = await uploadArtifactsCommand(
      baseArgs({ baseDir: home, paths: [inside, "/elsewhere/out.html"] }),
      baseDeps(fetch, writers),
    )

    expect(code).toBe(1)
    expect(calls).toHaveLength(0)
    expect(stdout.join("")).toContain("outside the base directory")
    expect(stdout.join("")).toContain("/elsewhere/out.html")
  })

  test("SC3: two inputs sharing one relative path stop the run before anything uploads", async () => {
    const { fetch, calls } = stubFetch(ok())
    const { stdout, writers } = io()

    const code = await uploadArtifactsCommand(
      baseArgs({ baseDir: "/work", paths: ["/work/shots/a.png", "/work/shots/nested/../a.png"] }),
      baseDeps(fetch, writers),
    )

    expect(code).toBe(1)
    expect(calls).toHaveLength(0)
    const output = stdout.join("")
    expect(output).toContain("shots/a.png")
    expect(output).toContain("/work/shots/a.png")
  })

  test("SC4: a vanished file and an oversize file are reported with their own, distinct reasons", async () => {
    const big = await tempFile("huge.md", "a".repeat(5 * 1024 * 1024 + 1))
    const gone = join(home, "gone.md")
    const { fetch, calls } = stubFetch(ok())
    const { stdout, writers } = io()

    const code = await uploadArtifactsCommand(
      baseArgs({ baseDir: home, paths: [gone, big] }),
      baseDeps(fetch, writers),
    )

    expect(code).toBe(1)
    expect(calls).toHaveLength(0)
    const lines = stdout.join("").split("\n")
    const vanishedLine = lines.find((line) => line.includes("gone.md"))
    const oversizeLine = lines.find((line) => line.includes("huge.md"))
    expect(vanishedLine).toContain("vanished")
    expect(vanishedLine).not.toContain("tooLarge")
    expect(oversizeLine).toContain("tooLarge")
    expect(oversizeLine).not.toContain("vanished")
  })

  test("SC5: --no-created records the file as edited with an unknown base", async () => {
    const path = await tempFile("notes.md", "content")
    const { fetch, calls } = stubFetch(ok())
    const { writers } = io()

    await uploadArtifactsCommand(
      baseArgs({ baseDir: home, paths: [path], created: false }),
      baseDeps(fetch, writers),
    )
    expect(calls[0]?.body.changeKind).toBe("editedUnknownBase")

    calls.length = 0
    await uploadArtifactsCommand(
      baseArgs({ baseDir: home, paths: [path], created: true }),
      baseDeps(fetch, writers),
    )
    expect(calls[0]?.body.changeKind).toBe("created")
  })

  test("SC6: a failed file does not stop the others", async () => {
    const paths = await Promise.all(
      ["a", "b", "c", "d"].map((name) => tempFile(`${name}.md`, `content ${name}`)),
    )
    const { fetch, calls } = stubFetch((_call, index) =>
      index === 1
        ? new Response(JSON.stringify({ error: "artifactTooLarge" }), { status: 413 })
        : ok()(),
    )
    const { stdout, writers } = io()

    const code = await uploadArtifactsCommand(
      baseArgs({ baseDir: home, paths }),
      baseDeps(fetch, writers),
    )

    expect(code).toBe(1)
    expect(calls).toHaveLength(4)
    const output = stdout.join("")
    expect(output).toContain("3 uploaded, 1 failed")
    expect(output).toContain("artifactTooLarge")
  })

  test("SC7: a session-not-found response stops the run immediately", async () => {
    let released: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      released = resolve
    })

    let call = 0
    vi.mocked(prepareUpload).mockImplementation(async (source) => {
      call += 1
      if (call > 2) await gate
      return {
        ok: true,
        upload: {
          sessionId: source.sessionId,
          path: source.path,
          relativePath: source.relativePath,
          mimeType: "text/markdown",
          changeKind: "created",
          encoding: "utf8",
          currentContent: "x",
          currentHash: "hash",
          observedAt: source.observedAt,
        },
      }
    })

    const { fetch, calls } = stubFetch((_call, index) =>
      index === 1
        ? new Response(JSON.stringify({ error: "sessionNotFound" }), { status: 409 })
        : ok()(),
    )
    const { stdout, writers } = io()

    const args = baseArgs({
      baseDir: "/work",
      paths: ["/work/a.md", "/work/b.md", "/work/c.md", "/work/d.md"],
    })
    const resultPromise = uploadArtifactsCommand(args, baseDeps(fetch, writers))

    // Waits for files 1 and 2's whole round trip, including the 409, while files 3 and 4 stay
    // gated behind `gate` and so cannot have reached their own fetch call yet.
    await waitUntil(() => calls.length >= 2)
    expect(calls).toHaveLength(2)

    released?.()
    const code = await resultPromise

    expect(code).toBe(1)
    expect(calls).toHaveLength(2)
    expect(calls.map((c) => c.body.relativePath)).toEqual(["a.md", "b.md"])
    expect(stdout.join("")).toContain("sess-1")
  })

  test("SC8: a file already stored under that path reports as updated", async () => {
    const path = await tempFile("notes.md", "content")
    const { fetch } = stubFetch(ok(true))
    const { stdout, writers } = io()

    const code = await uploadArtifactsCommand(
      baseArgs({ baseDir: home, paths: [path] }),
      baseDeps(fetch, writers),
    )

    expect(code).toBe(0)
    const output = stdout.join("")
    expect(output).toContain("updated")
    expect(output).toContain("1 uploaded, 0 failed")
  })

  test("SC21 (regression): a symlink pointing outside the base directory is refused", async () => {
    // A lexical containment check passes a symlink on its own name while `readFile` follows it to
    // the real target, which is how a base-dir refusal became an upload of an arbitrary file.
    const outside = await mkdtemp(join(tmpdir(), "samskara-artifacts-outside-"))
    try {
      const secret = join(outside, "id_rsa")
      await writeFile(secret, "PRIVATE KEY")
      const base = join(home, "base")
      await mkdir(base, { recursive: true })
      await symlink(secret, join(base, "innocuous.txt"))

      const { fetch, calls } = stubFetch(ok())
      const { stdout, writers } = io()

      const code = await uploadArtifactsCommand(
        baseArgs({ baseDir: base, paths: [join(base, "innocuous.txt")] }),
        baseDeps(fetch, writers),
      )

      expect(code).toBe(1)
      expect(calls).toHaveLength(0)
      expect(stdout.join("")).toContain("outside the base directory")
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  test("SC10: each file becomes one authenticated POST to the artifacts route", async () => {
    const paths = await Promise.all(
      ["a", "b", "c"].map((name) => tempFile(`${name}.md`, `content ${name}`)),
    )
    const { fetch, calls } = stubFetch(ok())
    const { writers } = io()

    const code = await uploadArtifactsCommand(
      baseArgs({ baseDir: home, paths }),
      baseDeps(fetch, writers, { apiBase: "http://api.example", token: "the-token" }),
    )

    expect(code).toBe(0)
    expect(calls).toHaveLength(3)
    // Concurrent dispatch does not guarantee the requests land in file order, so each is checked
    // against its own claimed relativePath rather than a fixed position.
    expect(calls.map((call) => call.body.relativePath).sort()).toEqual(["a.md", "b.md", "c.md"])
    for (const call of calls) {
      const name = call.body.relativePath.replace(".md", "")
      expect(call.url).toBe("http://api.example/api/artifacts")
      expect(call.headers.authorization).toBe("Bearer the-token")
      expect(call.body.sessionId).toBe("sess-1")
      expect(call.body.path).toBe(join(home, `${name}.md`))
      expect(call.body.mimeType).toBe("text/markdown")
      expect(call.body.encoding).toBe("utf8")
      expect(call.body.currentContent).toBe(`content ${name}`)
      expect(call.body.currentHash).toBeTruthy()
    }
  })

  test("SC11: a changed server url warns but the upload still runs", async () => {
    await atomicWriteJson(projectsPath(), {
      version: 1,
      apiBase: "http://old.example",
      projects: {},
    })
    const path = await tempFile("notes.md", "content")
    const { fetch, calls } = stubFetch(ok())
    const { stderr, writers } = io()

    const code = await uploadArtifactsCommand(
      baseArgs({ baseDir: home, paths: [path] }),
      baseDeps(fetch, writers),
    )

    expect(code).toBe(0)
    expect(calls).toHaveLength(1)
    expect(stderr.join("")).toContain("http://old.example")
    expect(stderr.join("")).toContain(DEFAULT_API_URL)
  })

  test("not logged in refuses before any upload is attempted", async () => {
    const { fetch, calls } = stubFetch(ok())
    const { writers } = io()

    const code = await uploadArtifactsCommand(
      baseArgs({ paths: ["/work/a.md"] }),
      baseDeps(fetch, writers, { token: null }),
    )

    expect(code).toBe(1)
    expect(calls).toHaveLength(0)
  })
})
