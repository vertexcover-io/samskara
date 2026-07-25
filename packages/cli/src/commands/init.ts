import { readToken as readStoredToken } from "../config/credentials.js"
import {
  watcherPid as readWatcherPid,
  resolveCliEntry,
  startWatcherDaemon,
} from "../config/daemon.js"
import { watchLogPath } from "../config/paths.js"
import { login as loginCommand } from "../login.js"
import { installHooksCommand, isManagedHookInstalled } from "./install-hooks.js"

interface Writer {
  write(text: string): unknown
}

export type InitOptions = {
  readonly readToken?: () => Promise<string | null>
  readonly login?: () => Promise<number>
  readonly hookInstalled?: () => boolean
  readonly installHooks?: () => number
  readonly watcherPid?: () => number | null
  readonly startWatcher?: () => number
  readonly stdout?: Writer
  readonly stderr?: Writer
}

export const initCommand = async (options: InitOptions = {}): Promise<number> => {
  const stdout = options.stdout ?? process.stdout
  const stderr = options.stderr ?? process.stderr
  const readToken = options.readToken ?? readStoredToken
  const hadToken = (await readToken()) !== null
  if (!hadToken) {
    const login = options.login ?? (() => loginCommand({ stdout, stderr }))
    if ((await login()) !== 0 || (await readToken()) === null) return 1
  } else {
    stdout.write("already logged in\n")
  }

  const hookInstalled = options.hookInstalled ?? (() => isManagedHookInstalled())
  const hadHook = hookInstalled()
  const installHooks = options.installHooks ?? (() => installHooksCommand({ stdout, stderr }))
  if (installHooks() !== 0) return 1

  const watcherPid = options.watcherPid ?? (() => readWatcherPid())
  const existingPid = watcherPid()
  if (existingPid === null) {
    try {
      const startWatcher =
        options.startWatcher ?? (() => startWatcherDaemon({ cliEntry: resolveCliEntry() }))
      const pid = startWatcher()
      stdout.write(`started watcher (pid ${pid}). logs: ${watchLogPath()}\n`)
    } catch (error) {
      stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      return 1
    }
  }

  if (hadToken && hadHook && existingPid !== null) stdout.write("nothing to do.\n")
  return 0
}
