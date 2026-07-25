import type { ProjectIdentity } from "@samskara/core"
import { readToken as readStoredToken } from "../config/credentials.js"
import {
  watcherPid as readWatcherPid,
  reviveWatcher as reviveStoredWatcher,
} from "../config/daemon.js"
import { watchLogPath } from "../config/paths.js"
import { isProjectEnabled as readProjectEnabled } from "../config/projects.js"
import { resolveLocalProject } from "../project-resolver.js"

interface Writer {
  write(text: string): unknown
}

export type EnsureOptions = {
  readonly cwd?: string
  readonly readToken?: () => Promise<string | null>
  readonly watcherPid?: () => number | null
  readonly reviveWatcher?: () => number | null
  readonly resolveProject?: (path: string) => Promise<ProjectIdentity>
  readonly isProjectEnabled?: (slug: string) => Promise<boolean>
  readonly stdout?: Writer
  readonly stderr?: Writer
}

const emitContext = (stdout: Writer, lines: ReadonlyArray<string>): void => {
  if (lines.length === 0) return
  stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: lines.join("\n"),
      },
    })}\n`,
  )
}

export const ensureCommand = async (options: EnsureOptions = {}): Promise<number> => {
  const stdout = options.stdout ?? process.stdout
  const stderr = options.stderr ?? process.stderr
  try {
    const token = await (options.readToken ?? readStoredToken)()
    if (!token) {
      emitContext(stdout, [
        "Samskara capture is OFF because the CLI is not authenticated. Tell the user to run `samskara login`.",
      ])
      return 0
    }

    const watcherPid = options.watcherPid ?? (() => readWatcherPid())
    const reviveWatcher = options.reviveWatcher ?? (() => reviveStoredWatcher())
    const context: string[] = []
    if (watcherPid() === null) {
      reviveWatcher()
      if (watcherPid() === null) {
        context.push(
          `Samskara capture may be OFF because the watcher did not stay running. Tell the user to check ${watchLogPath()}.`,
        )
      }
    }

    const cwd = options.cwd ?? process.cwd()
    const project = await (options.resolveProject ?? resolveLocalProject)(cwd)
    const enabled = await (options.isProjectEnabled ?? readProjectEnabled)(project.slug)
    if (!enabled) {
      context.push(
        `This project (${project.slug}) is not enabled for Samskara capture. Ask the user whether to enable it; if they agree, run \`samskara enable\`.`,
      )
    }
    emitContext(stdout, context)
  } catch (error) {
    stderr.write(`samskara ensure: ${error instanceof Error ? error.message : String(error)}\n`)
  }
  return 0
}
