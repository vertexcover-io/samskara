import { readToken } from "../config/credentials.js"
import { startWatcherDaemon, watcherPid } from "../config/daemon.js"
import { watchLogDir } from "../config/paths.js"
import { login } from "../login.js"
import { installHooksCommand, isManagedHookInstalled } from "./install-hooks.js"

interface Writer {
  write(text: string): unknown
}

export type InitOptions = {
  readonly stdout?: Writer
  readonly stderr?: Writer
}

export const initCommand = async (options: InitOptions = {}): Promise<number> => {
  const stdout = options.stdout ?? process.stdout
  const stderr = options.stderr ?? process.stderr

  const hadToken = (await readToken()) !== null
  if (!hadToken) {
    if ((await login({ stdout, stderr })) !== 0 || (await readToken()) === null) return 1
  } else {
    stdout.write("already logged in\n")
  }

  const hadHook = isManagedHookInstalled()
  if (installHooksCommand({ stdout, stderr }) !== 0) return 1

  const existingPid = watcherPid()
  if (existingPid === null) {
    try {
      const pid = await startWatcherDaemon()
      stdout.write(
        `Started the capture watcher (process ${pid}). Its logs are in ${watchLogDir()}.\n`,
      )
    } catch (error) {
      stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      return 1
    }
  }

  if (hadToken && hadHook && existingPid !== null) stdout.write("nothing to do.\n")
  return 0
}
