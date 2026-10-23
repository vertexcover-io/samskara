import { isAbsolute } from "node:path"
import { z } from "zod"
import { readToken } from "../config/credentials.js"
import { reviveWatcher, watcherPid } from "../config/daemon.js"
import { watchLogDir } from "../config/paths.js"
import { isProjectEnabled } from "../config/projects.js"
import { scopeMismatch, TRIPWIRE_PATHS } from "../config/server-scope.js"
import { errorMessage, resolveIo, type Writer } from "../io.js"
import { checkToken } from "../login.js"
import { resolveProject } from "../watcher/resolveProject.js"

export type EnsureOptions = {
  readonly agent?: string
  readonly input?: string
  readonly cwd?: string
  readonly stdout?: Writer
  readonly stderr?: Writer
}

const readHookInput = (): Promise<string> =>
  new Promise((resolve) => {
    let input = ""
    const finish = (): void => {
      clearTimeout(timer)
      process.stdin.off("data", onData)
      process.stdin.off("end", finish)
      process.stdin.pause()
      resolve(input)
    }
    const onData = (chunk: Buffer): void => {
      if (input.length + chunk.length > 131_072) {
        input = ""
        finish()
        return
      }
      input += chunk.toString("utf8")
    }
    const timer = setTimeout(finish, 1_000)
    process.stdin.on("data", onData)
    process.stdin.once("end", finish)
    process.stdin.resume()
  })
const hookSchema = z.object({ cwd: z.string().refine(isAbsolute) })

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
  const { stdout, stderr } = resolveIo(options)
  try {
    const cwd =
      options.agent === "codex"
        ? hookSchema.parse(JSON.parse(options.input ?? (await readHookInput()))).cwd
        : (options.cwd ?? process.cwd())
    const token = await readToken()
    if (!token) {
      emitContext(stdout, [
        "Samskara capture is OFF because the CLI is not authenticated. Tell the user to run `samskara login`.",
      ])
      return 0
    }

    const context: string[] = []
    const [mismatch] = await scopeMismatch(TRIPWIRE_PATHS())
    if (mismatch !== undefined) {
      context.push(
        `Samskara capture is OFF: local state was captured against ${mismatch.recorded}, but the CLI ` +
          `is configured for ${mismatch.current}. Tell the user to run \`samskara init --force\`.`,
      )
    }
    // `watch()` throws on a mismatch, so reviving here would spawn a process guaranteed to die.
    if (mismatch === undefined && watcherPid() === null) {
      await reviveWatcher()
      if (watcherPid() === null) {
        context.push(
          `Samskara capture may be OFF because the watcher did not stay running. Tell the user to check ${watchLogDir()}.`,
        )
      }
    }

    const project = await resolveProject(cwd)
    if (project === null || !(await isProjectEnabled(project.slug))) {
      context.push(
        project === null
          ? "This folder could not be identified, so Samskara captures nothing here."
          : `This project (${project.slug}) is not enabled for Samskara capture. Ask the user whether to enable it; if they agree, run \`samskara enable\`.`,
      )
      // A disabled project uploads nothing, so a server round trip would only add startup latency.
      emitContext(stdout, context)
      return 0
    }

    // An enabled project is about to upload, so a token the server no longer accepts is a real
    // outage. An unreachable server is not: the hook fails open rather than crying wolf.
    if ((await checkToken(token)) === "rejected") {
      context.push(
        `Samskara capture is OFF for this project (${project.slug}) because the server rejected the stored credentials. Tell the user to run \`samskara login\` to pair again.`,
      )
    }
    emitContext(stdout, context)
  } catch (error) {
    stderr.write(`samskara ensure: ${errorMessage(error)}\n`)
  }
  return 0
}
