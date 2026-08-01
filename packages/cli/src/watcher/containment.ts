import { homedir } from "node:os"
import { basename, join, resolve, sep } from "node:path"

export const EXCLUDED_DIRS = [
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
] as const

export const EXCLUDED_GLOBS = [
  "*.log",
  "*.tsbuildinfo",
  "*.pid",
  ".DS_Store",
  "*.lock",
  "package-lock.json",
  "bun.lock",
  ".env",
  ".env.*",
] as const

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

const isHomeDotfile = (path: string, home: string): boolean =>
  isInside(path, home) &&
  basename(path).startsWith(".") &&
  segmentsOf(path).length === segmentsOf(home).length + 1

/**
 * Excluded regardless of the root check: each of these can legitimately sit inside a
 * project root, and none of them is the agent's output.
 */
const alwaysExcluded = (path: string): boolean => {
  const home = resolve(homedir())
  const roots = [join(home, ".claude"), join(home, ".agent"), "/tmp", "/private/tmp"]
  return roots.some((root) => isInside(path, root)) || isHomeDotfile(path, home)
}

/**
 * The order is the point: `isCapturable` is lexical, so a symlink inside the root pointing outside
 * it passes on its own path while every later read follows the link to the real target. Resolving
 * first is what makes containment mean what it says, and both callers need the same rule.
 */
export const capturableRealpath = async (
  path: string,
  projectRoot: string,
  realpath: (target: string) => Promise<string>,
): Promise<string | null> => {
  const resolved = await realpath(path).catch(() => path)
  return isCapturable(resolved, projectRoot) ? resolved : null
}

export const isCapturable = (absolutePath: string, projectRoot: string): boolean => {
  const path = resolve(absolutePath)
  const root = resolve(projectRoot)

  if (alwaysExcluded(path)) return false
  if (!isInside(path, root)) return false

  const relativeSegments = segmentsOf(path.slice(root.length))
  if (relativeSegments.some((segment) => EXCLUDED_DIRS.some((dir) => dir === segment))) return false

  const name = basename(path)
  return !EXCLUDED_GLOBS.some((glob) => matchesGlob(name, glob))
}
