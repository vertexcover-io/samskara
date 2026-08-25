import { rm } from "node:fs/promises"
import { deleteToken } from "../config/credentials.js"
import { stopWatcherDaemon } from "../config/daemon.js"
import { filterOptionsPath } from "../config/paths.js"
import { resolveIo, type Writer } from "../io.js"

export type LogoutOptions = {
  readonly stdout?: Writer
}

export const logoutCommand = async (options: LogoutOptions = {}): Promise<number> => {
  await stopWatcherDaemon()
  await deleteToken()
  // `search` caches the project and repo names this account was allowed to see. Delete it, or
  // the next person to log in resolves names against the last person's list.
  await rm(filterOptionsPath(), { force: true })
  const { stdout } = resolveIo(options)
  stdout.write(
    "Logged out. The stored access token was removed and the capture watcher was stopped.\n",
  )
  return 0
}
