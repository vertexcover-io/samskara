#!/usr/bin/env bun
import { execFileSync, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { nextVersion } from "./version.ts"

export type Options = { bump: string; ref: string | null; watch: boolean }

const USAGE = "usage: bun run release <major|minor|patch|x.y.z> [--ref BRANCH] [--watch]"

const REF_FLAG = "--ref="

/**
 * The bump is validated here by the same function the workflow will run, so a typo costs a
 * shell error rather than a dispatched run that dies three jobs later.
 */
export const parseArgs = (argv: readonly string[]): Options => {
  const rest = [...argv]
  let bump: string | null = null
  let ref: string | null = null
  let watch = false

  while (rest.length > 0) {
    const arg = rest.shift() as string
    if (arg === "--watch") {
      watch = true
      continue
    }
    if (arg === "--ref") {
      ref = rest.shift() ?? ""
      continue
    }
    if (arg.startsWith(REF_FLAG)) {
      ref = arg.slice(REF_FLAG.length)
      continue
    }
    if (arg.startsWith("--")) throw new Error(`unknown flag "${arg}"\n${USAGE}`)
    if (bump !== null) throw new Error(`unexpected argument "${arg}"\n${USAGE}`)
    bump = arg
  }

  if (ref === "") throw new Error(`--ref needs a branch name\n${USAGE}`)
  if (bump === null) throw new Error(USAGE)
  nextVersion("0.0.0", bump)
  return { bump, ref, watch }
}

export const dispatchArgs = (bump: string, ref: string): string[] => [
  "workflow",
  "run",
  "release.yml",
  "--ref",
  ref,
  "-f",
  `bump=${bump}`,
]

type Run = { databaseId: number; url: string; createdAt: string }

const repoRoot = fileURLToPath(new URL("..", import.meta.url))

const run = (command: string, args: string[]): string =>
  execFileSync(command, args, { cwd: repoRoot, encoding: "utf8" }).trim()

const git = (...args: string[]): string => run("git", args)

const gh = (...args: string[]): string => {
  try {
    return run("gh", args)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("gh is not installed: brew install gh && gh auth login")
    }
    throw error
  }
}

/**
 * The workflow builds from what origin has, so a local commit that has not been pushed would be
 * left out of the release it was meant to cut.
 */
const assertPushed = (ref: string): void => {
  git("fetch", "origin", ref)
  if (git("rev-parse", ref) === git("rev-parse", `origin/${ref}`)) return
  throw new Error(`${ref} differs from origin/${ref}: push before releasing`)
}

const findRun = (ref: string, after: string): Run | null => {
  const rows: Run[] = JSON.parse(
    gh(
      "run",
      "list",
      "--workflow=release.yml",
      "--event=workflow_dispatch",
      "--branch",
      ref,
      "--limit",
      "10",
      "--json",
      "databaseId,url,createdAt",
    ),
  )
  return rows.find((candidate) => candidate.createdAt >= after) ?? null
}

/** gh dispatches without telling you which run it started, so the run is matched by start time. */
const awaitRun = (ref: string, after: string): Run | null => {
  for (let attempt = 0; attempt < 10; attempt++) {
    const started = findRun(ref, after)
    if (started !== null) return started
    Bun.sleepSync(2000)
  }
  return null
}

const main = (): void => {
  const options = parseArgs(process.argv.slice(2))
  const ref = options.ref ?? git("rev-parse", "--abbrev-ref", "HEAD")
  assertPushed(ref)

  const after = new Date(Date.now() - 1000).toISOString()
  gh(...dispatchArgs(options.bump, ref))
  console.log(`dispatched a ${options.bump} release of ${ref}`)

  const started = awaitRun(ref, after)
  if (started === null) {
    console.log("could not find the run yet: gh run list --workflow=release.yml")
    return
  }
  console.log(started.url)
  if (!options.watch) return

  const watched = spawnSync("gh", ["run", "watch", String(started.databaseId), "--exit-status"], {
    cwd: repoRoot,
    stdio: "inherit",
  })
  process.exit(watched.status ?? 1)
}

if (import.meta.main) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
