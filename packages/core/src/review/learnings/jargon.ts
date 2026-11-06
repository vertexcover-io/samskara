import { readdir } from "node:fs/promises"
import { join } from "node:path"

/** Folders whose entries are names a reader never heard of: skill, agent, hook and command names. */
const NAMED_FOLDERS: ReadonlyArray<string> = ["skills", "agents", "hooks", "commands"]

/**
 * Where a harness keeps those folders: its root, and the per-agent copies beside it. Only these
 * are read, because a `src/agents` or `src/hooks` deeper in is source code, and its file names
 * (common, index) are everyday words.
 */
const HARNESS_ROOTS: ReadonlyArray<string> = ["", ".claude", ".codex", ".agents"]

/** Words no list line may use, whatever the harness holds. */
const ALWAYS: ReadonlyArray<string> = ["yok", "harness"]

/**
 * Entry names that are also everyday words. Banning these would make a fix unsayable ("fix
 * the review step"), so the writing rules keep them plain instead of the check.
 */
export const EVERYDAY_WORDS: ReadonlySet<string> = new Set([
  "build",
  "check",
  "commit",
  "debug",
  "deploy",
  "design",
  "docs",
  "explore",
  "fix",
  "format",
  "help",
  "implement",
  "init",
  "learn",
  "lint",
  "plan",
  "planning",
  "read",
  "readme",
  "refactor",
  "release",
  "report",
  "research",
  "review",
  "run",
  "search",
  "setup",
  "start",
  "status",
  "stop",
  "summary",
  "test",
  "tests",
  "update",
  "verify",
  "worker",
  "write",
])

/** Files a named folder may hold beside its entries: tests and type declarations name nothing. */
const NOT_AN_ENTRY = /\.(test|spec)\.|\.d\.ts$/

/**
 * The words the writer's four list lines may not use, lowercase and sorted: `ALWAYS`, the
 * harness's own name, and every skill, agent, hook and command name in `harnessDir` that is
 * not an everyday word.
 */
export const projectWords = async (harnessDir: string, harnessName?: string): Promise<string[]> => {
  const words = new Set<string>(ALWAYS)
  if (harnessName !== undefined && harnessName !== "") words.add(harnessName.toLowerCase())
  const folders = HARNESS_ROOTS.flatMap((root) =>
    NAMED_FOLDERS.map((f) => join(harnessDir, root, f)),
  )
  // A harness has only some of these folders; a missing one has no names.
  for (const folder of folders)
    for (const inner of await readdir(folder).catch(() => [])) {
      if (NOT_AN_ENTRY.test(inner)) continue
      const name = (inner.split(".")[0] ?? "").toLowerCase()
      if (name.length > 1 && !EVERYDAY_WORDS.has(name)) words.add(name)
    }
  return [...words].sort()
}
