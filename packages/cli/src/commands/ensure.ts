import { readToken } from "../config/credentials.js"
import { reviveWatcher, watcherPid } from "../config/daemon.js"
import { watchLogDir } from "../config/paths.js"
import { isProjectEnabled } from "../config/projects.js"
import { resolveLocalProject } from "../project-resolver.js"

interface Writer {
  write(text: string): unknown
}

export type EnsureOptions = {
  readonly cwd?: string
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
    const token = await readToken()
    if (!token) {
      emitContext(stdout, [
        "Samskara capture is OFF because the CLI is not authenticated. Tell the user to run `samskara login`.",
      ])
      return 0
    }

    const context: string[] = []
    if (watcherPid() === null) {
      await reviveWatcher()
      if (watcherPid() === null) {
        context.push(
          `Samskara capture may be OFF because the watcher did not stay running. Tell the user to check ${watchLogDir()}.`,
        )
      }
    }

    const project = await resolveLocalProject(options.cwd ?? process.cwd())
    if (!(await isProjectEnabled(project.slug))) {
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
