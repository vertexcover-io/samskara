import { deleteToken } from "../config/credentials.js"
import { stopWatcherDaemon } from "../config/daemon.js"
import { resolveIo, type Writer } from "../io.js"

export type LogoutOptions = {
  readonly stdout?: Writer
}

export const logoutCommand = async (options: LogoutOptions = {}): Promise<number> => {
  await stopWatcherDaemon()
  await deleteToken()
  const { stdout } = resolveIo(options)
  stdout.write(
    "Logged out. The stored access token was removed and the capture watcher was stopped.\n",
  )
  return 0
}
