import { realpath, stat } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path"

export type CaptureDecision =
  | { readonly ok: true; readonly path: string; readonly relativePath: string }
  | { readonly ok: false; readonly reason: string }

export type CaptureOptions = {
  readonly projectRoot: string
  readonly allowScratch: boolean
}

const SECRET_NAMES: ReadonlySet<string> = new Set([
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
])

const SECRET_EXTENSIONS = [
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".jks",
  ".keystore",
  ".kdbx",
  ".asc",
  ".gpg",
] as const

const SECRET_DIRS: ReadonlySet<string> = new Set([".ssh", ".gnupg", ".aws", ".kube", ".docker"])

const HOME = resolve(homedir())

/**
 * No `/var` rule: on macOS the real temp dir resolves under `/private/var`, and denying that whole
 * subtree would take the scratch zone with it.
 */
const SYSTEM_ROOTS: ReadonlyArray<string> = [
  "/etc",
  "/usr",
  "/bin",
  "/sbin",
  "/boot",
  "/proc",
  "/sys",
  "/dev",
  "/System",
  "/Library",
  join(HOME, ".claude"),
  join(HOME, ".agent"),
]

const NOISE_GLOBS = [
  "*.log",
  "*.tsbuildinfo",
  "*.pid",
  ".DS_Store",
  "*.lock",
  "package-lock.json",
  "bun.lock",
  "yarn.lock",
  "pnpm-lock.yaml",
] as const

const NOISE_DIRS: ReadonlySet<string> = new Set([
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
])

const canonical = async (path: string): Promise<string> => realpath(path).catch(() => resolve(path))

/** `/tmp` is a symlink to `/private/tmp` on macOS, so every zone comparison is on resolved form. */
const SCRATCH_ROOTS: Promise<ReadonlyArray<string>> = Promise.all(
  [tmpdir(), "/tmp", "/private/tmp"].map(canonical),
).then((roots) => [...new Set(roots)])

const withTrailingSeparator = (path: string): string =>
  path.endsWith(sep) ? path : `${path}${sep}`

const isInside = (path: string, root: string): boolean =>
  path === root || path.startsWith(withTrailingSeparator(root))

const segmentsOf = (path: string): ReadonlyArray<string> =>
  path.split(sep).filter((segment) => segment.length > 0)

const matchesGlob = (name: string, glob: string): boolean => {
  if (!glob.includes("*")) return name === glob
  const [prefix = "", suffix = ""] = glob.split("*")
  return (
    name.length >= prefix.length + suffix.length && name.startsWith(prefix) && name.endsWith(suffix)
  )
}

const isSecret = (path: string): boolean => {
  const name = basename(path)
  if (SECRET_NAMES.has(name) || name.startsWith(".env.")) return true
  if (SECRET_EXTENSIONS.some((extension) => name.endsWith(extension))) return true
  return segmentsOf(path).some((segment) => SECRET_DIRS.has(segment))
}

const isSystem = (path: string): boolean => SYSTEM_ROOTS.some((root) => isInside(path, root))

const isNoise = (path: string, zoneRoot: string): boolean => {
  if (NOISE_GLOBS.some((glob) => matchesGlob(basename(path), glob))) return true
  return segmentsOf(relative(zoneRoot, path)).some((segment) => NOISE_DIRS.has(segment))
}

/** Ordered most severe first, so a file named `.env.log` is reported as a secret rather than noise. */
const deniedBy = (path: string, zoneRoot: string): string | null => {
  if (isSecret(path)) return "looks like a secret or credential"
  if (isSystem(path)) return "inside a system or agent directory"
  if (isNoise(path, zoneRoot)) return "excluded as build output or noise"
  return null
}

/**
 * The project root wins over an enclosing scratch root, so a project living under the temp dir is
 * still measured against itself.
 */
const rootFor = async (
  path: string,
  projectRoot: string,
  allowScratch: boolean,
): Promise<string | undefined> => {
  if (isInside(path, projectRoot)) return projectRoot
  if (!allowScratch) return undefined
  return (await SCRATCH_ROOTS).find((root) => isInside(path, root))
}

/**
 * Realpath precedes every containment check: a symlink inside the root pointing outside it passes
 * on its own path, while every later read follows the link to the real target. Failing to resolve
 * is a rejection rather than a fallback to the unresolved path, which would reopen that hole.
 */
const decide = async (
  input: string,
  projectRoot: string,
  allowScratch: boolean,
): Promise<CaptureDecision> => {
  const path = await realpath(resolve(input)).catch(() => null)
  if (path === null) return { ok: false, reason: "path does not resolve" }

  const root = await rootFor(path, projectRoot, allowScratch)
  if (root === undefined) return { ok: false, reason: "outside the project root" }

  const denial = deniedBy(path, root)
  if (denial !== null) return { ok: false, reason: denial }

  const info = await stat(path).catch(() => null)
  if (info?.isFile() !== true) return { ok: false, reason: "not a regular file" }

  return { ok: true, path, relativePath: relative(root, path) }
}

/**
 * One decision per input path, in the same order.
 *
 * A root that is not already absolute rejects the whole batch rather than being resolved: `resolve`
 * would silently anchor it to the daemon's cwd, and every caller that got here with a bad root would
 * have its containment measured against an unrelated directory.
 */
export const shouldCaptureArtifacts = async (
  paths: ReadonlyArray<string>,
  opts: CaptureOptions,
): Promise<ReadonlyArray<CaptureDecision>> => {
  if (!isAbsolute(opts.projectRoot)) {
    return paths.map(() => ({ ok: false, reason: "project root is not an absolute path" }))
  }
  const projectRoot = await canonical(opts.projectRoot)
  return Promise.all(paths.map((path) => decide(path, projectRoot, opts.allowScratch)))
}
