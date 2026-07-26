import type { ProjectIdentity } from "@samskara/core"
import { startWatcherDaemon, watcherPid } from "../config/daemon.js"
import { createWatchLogger } from "../config/log.js"
import { watchLogDir } from "../config/paths.js"
import { watch } from "../watcher/index.js"

interface Writer {
  write(text: string): unknown
}

export type WatchCommandOptions = {
  readonly foreground?: boolean
  readonly verbose?: boolean
  readonly projectOverride?: ProjectIdentity
  readonly stdout?: Writer
  readonly stderr?: Writer
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export const watchCommand = async (options: WatchCommandOptions = {}): Promise<number> => {
  const stdout = options.stdout ?? process.stdout
  const stderr = options.stderr ?? process.stderr

  if (options.foreground) {
    try {
      await watch({
        ...(options.projectOverride ? { projectOverride: options.projectOverride } : {}),
        log: createWatchLogger({
          verbose: Boolean(options.verbose),
          pretty: process.env.SAMSKARA_DAEMON !== "1",
        }).log,
      })
      return 0
    } catch (error) {
      stderr.write(`${message(error)}\n`)
      return 1
    }
  }

  const existing = watcherPid()
  if (existing !== null) {
    stdout.write(`watcher already running (pid ${existing}). logs: ${watchLogDir()}\n`)
    return 0
  }

  try {
    const pid = await startWatcherDaemon()
    stdout.write(
      `Started the capture watcher (process ${pid}). Its logs are in ${watchLogDir()}.\n`,
    )
    return 0
  } catch (error) {
    stderr.write(`${message(error)}\n`)
    return 1
  }
}
