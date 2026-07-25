import { deleteToken } from "../config/credentials.js"
import { stopWatcherDaemon } from "../config/daemon.js"

interface Writer {
  write(text: string): unknown
}

export type LogoutOptions = {
  readonly stopWatcher?: () => Promise<boolean>
  readonly stdout?: Writer
}

export const logoutCommand = async (options: LogoutOptions = {}): Promise<number> => {
  await (options.stopWatcher ?? (() => stopWatcherDaemon()))()
  await deleteToken()
  const stdout = options.stdout ?? process.stdout
  stdout.write("logged out; watcher stopped.\n")
  return 0
}
