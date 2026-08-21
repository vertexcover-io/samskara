import { readToken } from "../config/credentials.js"
import { startWatcherDaemon, stopWatcherDaemon } from "../config/daemon.js"
import { watchLogDir } from "../config/paths.js"
import { type IoOptions, reportError, resolveIo } from "../io.js"
import { checkToken } from "../login.js"

const LOGIN_HINT = "Run `samskara login` to pair this CLI, then restart the watcher."

export const restartCommand = async (options: IoOptions = {}): Promise<number> => {
  const { stdout, stderr } = resolveIo(options)

  const token = await readToken()
  if (!token) {
    stderr.write(`This CLI is not logged in, so the watcher would upload nothing.\n${LOGIN_HINT}\n`)
    return 1
  }

  // A watcher started on credentials the server rejects only produces 401s, so the check happens
  // before the running one is torn down. An unreachable server is not a rejection: the watcher
  // retries every cycle, so the restart goes ahead.
  const checked = await checkToken(token)
  if (checked === "rejected") {
    stderr.write(`The server rejected the stored credentials.\n${LOGIN_HINT}\n`)
    return 1
  }
  if (checked === "unreachable") {
    stdout.write("The server could not be reached, so the stored credentials were not verified.\n")
  }

  try {
    const stopped = await stopWatcherDaemon()
    const pid = await startWatcherDaemon()
    stdout.write(
      `${stopped ? "Restarted" : "Started"} the capture watcher (process ${pid}). Its logs are in ${watchLogDir()}.\n`,
    )
    return 0
  } catch (error) {
    return reportError(stderr, error)
  }
}
