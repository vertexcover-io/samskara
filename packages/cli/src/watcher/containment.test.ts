import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { type CaptureDecision, shouldCaptureArtifacts } from "./containment.js"

const fixtureBase = dirname(fileURLToPath(import.meta.url))

test("custom Codex state roots cannot become artifacts through a symlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "samskara-codex-containment-"))
  const state = await write(join(root, "codex-state", "state.sqlite"))
  const alias = join(root, "alias")
  await symlink(join(root, "codex-state"), alias)
  const previous = process.env.CODEX_SQLITE_HOME
  process.env.CODEX_SQLITE_HOME = alias
  try {
    expect(
      await shouldCaptureArtifacts([state], { projectRoot: root, allowScratch: true }),
    ).toMatchObject([{ ok: false, reason: "inside a system or agent directory" }])
  } finally {
    if (previous === undefined) delete process.env.CODEX_SQLITE_HOME
    else process.env.CODEX_SQLITE_HOME = previous
    await rm(root, { recursive: true, force: true })
  }
})

const write = async (path: string, body = "bytes"): Promise<string> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, body, "utf8")
  return path
}

const SECRET = /secret/
const NOISE = /noise/

const denied: ReadonlyArray<{
  readonly kind: string
  readonly path: string
  readonly reason: RegExp
}> = [
  ...[
    ".env",
    ".netrc",
    ".npmrc",
    ".pypirc",
    ".git-credentials",
    ".htpasswd",
    "id_rsa",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
    "credentials",
    "credentials.json",
  ].map((name) => ({ kind: "a secret name", path: `keys/${name}`, reason: SECRET })),
  { kind: "a suffixed environment file", path: ".env.production", reason: SECRET },
  ...[".pem", ".key", ".p12", ".pfx", ".jks", ".keystore", ".kdbx", ".asc", ".gpg"].map(
    (extension) => ({
      kind: "a secret extension",
      path: `keys/server${extension}`,
      reason: SECRET,
    }),
  ),
  ...[".ssh", ".gnupg", ".aws", ".kube", ".docker"].map((dir) => ({
    kind: "a secret directory at any depth",
    path: `deploy/hosts/${dir}/material`,
    reason: SECRET,
  })),
  ...[
    "run.log",
    "tsconfig.tsbuildinfo",
    "daemon.pid",
    ".DS_Store",
    "deps.lock",
    "package-lock.json",
    "bun.lock",
    "yarn.lock",
    "pnpm-lock.yaml",
  ].map((name) => ({ kind: "a noise file", path: `noise/${name}`, reason: NOISE })),
  ...[
    "node_modules",
    "vendor",
    ".venv",
    "target",
    "dist",
    "build",
    "out",
    ".next",
    ".turbo",
    "coverage",
    "__pycache__",
  ].map((dir) => ({ kind: "an excluded directory", path: `app/${dir}/file.txt`, reason: NOISE })),
]

describe("shouldCaptureArtifacts", () => {
  let base: string
  let root: string
  let outside: string
  let scratchFile: string

  const only = async (
    path: string,
    opts: { readonly projectRoot: string; readonly allowScratch: boolean },
  ): Promise<CaptureDecision> => {
    const [decision] = await shouldCaptureArtifacts([path], opts)
    if (!decision) throw new Error("shouldCaptureArtifacts returned no decision")
    return decision
  }

  const inRoot = (path: string): Promise<CaptureDecision> =>
    only(path, { projectRoot: root, allowScratch: false })

  const rejection = async (path: string): Promise<string> => {
    const decision = await inRoot(path)
    return decision.ok ? "accepted" : decision.reason
  }

  afterAll(async () => {
    await rm(base, { recursive: true, force: true })
    await rm(scratchFile, { force: true })
  })

  beforeAll(async () => {
    // Deliberately NOT the system temp dir: that is the scratch zone, so a fixture there would
    // exercise the scratch gate rather than the project root.
    base = await realpath(await mkdtemp(join(fixtureBase, "samskara-containment-")))
    root = join(base, "repo")
    outside = join(base, "outside")

    await Promise.all(
      [
        "src/index.ts",
        "src/distribution.ts",
        "packages/web/src/App.tsx",
        "docs/adr-001.md",
        "docs/real.md",
        "building/plan.md",
        ".harness/features/x/design.md",
        ".env.log",
        ...denied.map((row) => row.path),
      ].map((relative) => write(join(root, relative))),
    )
    await write(join(outside, "secret.md"))
    await mkdir(join(root, "empty-dir"), { recursive: true })
    await symlink(join(outside, "secret.md"), join(root, "escape.md"))
    await symlink(join(root, "docs", "real.md"), join(root, "inside-link.md"))

    scratchFile = join(tmpdir(), `samskara-containment-${randomUUID()}.py`)
    await writeFile(scratchFile, "print(1)", "utf8")
  })

  const accepted: ReadonlyArray<readonly [string, string]> = [
    ["a source file", "src/index.ts"],
    ["a file in a monorepo package", "packages/web/src/App.tsx"],
    ["a repo-root docs file", "docs/adr-001.md"],
    ["a file whose name merely contains an excluded word", "src/distribution.ts"],
    ["a directory whose name merely starts with an excluded word", "building/plan.md"],
    // `.harness/` is gitignored in this very repo, and plans are exactly the high-value output
    // this feature exists to capture -- so exclusion is a list, never `.gitignore`.
    ["a gitignored plan", ".harness/features/x/design.md"],
  ]

  test.each(accepted)("S6: accepts %s", async (_label, relative) => {
    const decision = await inRoot(join(root, relative))

    expect(decision).toEqual({ ok: true, path: join(root, relative), relativePath: relative })
  })

  test.each(denied)("S6: rejects $path as $kind", async ({ path, reason }) => {
    expect(await rejection(join(root, path))).toMatch(reason)
  })

  test("S6: a sibling directory outside the root is rejected", async () => {
    expect(await rejection(join(outside, "secret.md"))).toMatch(/outside the project root/)
  })

  test("S6: a file that is both a secret and noise reports as a secret", async () => {
    expect(await rejection(join(root, ".env.log"))).toMatch(/secret/)
  })

  test("S8: a traversal that escapes the root is rejected", async () => {
    expect(await rejection(join(root, "src", "..", "..", "outside", "secret.md"))).toMatch(
      /outside the project root/,
    )
  })

  test("S8: a traversal that stays inside the root is normalized and accepted", async () => {
    const decision = await inRoot(join(root, "docs", "..", "src", "index.ts"))

    expect(decision).toEqual({
      ok: true,
      path: join(root, "src", "index.ts"),
      relativePath: join("src", "index.ts"),
    })
  })

  test("S8: a symlink pointing outside the root is rejected", async () => {
    expect(await rejection(join(root, "escape.md"))).toMatch(/outside the project root/)
  })

  test("S8: a symlink pointing inside the root is accepted as its target", async () => {
    const decision = await inRoot(join(root, "inside-link.md"))

    expect(decision).toEqual({
      ok: true,
      path: join(root, "docs", "real.md"),
      relativePath: join("docs", "real.md"),
    })
  })

  test("S8: a directory is rejected", async () => {
    expect(await rejection(join(root, "empty-dir"))).toMatch(/not a regular file/)
  })

  test("S8: a path that does not exist is rejected", async () => {
    expect(await rejection(join(root, "src", "gone.ts"))).toMatch(/does not resolve/)
  })

  test("S6: a scratch file is captured with allowScratch, named against its scratch root", async () => {
    const resolved = await realpath(scratchFile)

    const decision = await only(scratchFile, { projectRoot: root, allowScratch: true })

    expect(decision).toEqual({ ok: true, path: resolved, relativePath: basename(scratchFile) })
  })

  test("S6: the same scratch file is rejected without allowScratch", async () => {
    expect(await rejection(scratchFile)).toMatch(/outside the project root/)
  })

  test("S6: a system path is denied while the real temp dir is not", async () => {
    const wholeDisk = { projectRoot: "/", allowScratch: false }
    const system = await only("/usr/bin/env", wholeDisk)
    const scratch = await only(scratchFile, wholeDisk)

    expect(system.ok === false && system.reason).toMatch(/system/)
    // On macOS `os.tmpdir()` resolves under `/private/var`, so any blanket `/var` system rule
    // would swallow the real temp dir.
    expect(scratch.ok).toBe(true)
  })

  test("S6: a project root inside the temp dir wins over the scratch zone", async () => {
    const tmpRoot = await realpath(await mkdtemp(join(tmpdir(), "samskara-containment-root-")))
    const target = await write(join(tmpRoot, "docs", "a.md"))

    const decision = await only(target, { projectRoot: tmpRoot, allowScratch: true })

    expect(decision).toEqual({ ok: true, path: target, relativePath: join("docs", "a.md") })
    await rm(tmpRoot, { recursive: true, force: true })
  })

  test("S6: one decision per input path, in input order, because the driver pairs them by index", async () => {
    const decisions = await shouldCaptureArtifacts(
      [join(root, "src", "index.ts"), join(root, "docs", "adr-001.md"), join(root, ".env")],
      { projectRoot: root, allowScratch: false },
    )

    expect(decisions.map((decision) => (decision.ok ? decision.relativePath : "denied"))).toEqual([
      join("src", "index.ts"),
      join("docs", "adr-001.md"),
      "denied",
    ])
  })
})
