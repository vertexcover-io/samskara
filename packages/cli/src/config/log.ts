import { mkdirSync } from "node:fs"
import { createLogger } from "@samskara/core"
import pino from "pino"
import { watchLogDir } from "./paths.js"

const RETAINED_LOG_FILES = 7

export type WatchLoggerOptions = {
  readonly verbose?: boolean
  readonly pretty?: boolean
}

export type WatchLogger = {
  readonly log: pino.Logger
  readonly ready: () => Promise<void>
}

type Target = pino.TransportTargetOptions

export const prettyTarget: Target = {
  target: "pino-pretty",
  options: {
    destination: 1,
    colorize: true,
    translateTime: "SYS:HH:MM:ss",
    ignore: "pid,hostname",
  },
}

const rollTarget = (): Target => ({
  target: "pino-roll",
  options: {
    file: `${watchLogDir()}/watch`,
    extension: ".log",
    frequency: "daily",
    dateFormat: "yyyy-MM-dd",
    size: "10m",
    limit: { count: RETAINED_LOG_FILES, removeOtherLogFiles: true },
    symlink: true,
    mkdir: true,
  },
})

export const createWatchLogger = (options: WatchLoggerOptions = {}): WatchLogger => {
  mkdirSync(watchLogDir(), { recursive: true })
  const targets: Target[] = options.pretty ? [rollTarget(), prettyTarget] : [rollTarget()]
  const destination = pino.transport({ targets })

  // Not LOG_LEVEL: these lines go to the file `samskara logs` reads back, not to a terminal.
  const log = createLogger(
    { service: "samskara-cli" },
    { destination, level: options.verbose ? "debug" : "info" },
  )

  const ready = (): Promise<void> =>
    new Promise((resolve, reject) => {
      destination.on("ready", () => resolve())
      destination.on("error", reject)
    })

  return { log, ready }
}
