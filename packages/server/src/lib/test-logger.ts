import { createLogger } from "@samskara/core"
import type pino from "pino"

export type CapturedLine = Record<string, unknown> & {
  readonly msg: string
  readonly level: number
}

export type CaptureLogger = {
  readonly log: pino.Logger
  readonly lines: ReadonlyArray<CapturedLine>
  readonly at: (level: pino.Level) => ReadonlyArray<CapturedLine>
}

const LEVELS: Record<string, number> = { debug: 20, info: 30, warn: 40, error: 50, fatal: 60 }

export const captureLogger = (): CaptureLogger => {
  const lines: CapturedLine[] = []
  const log = createLogger(
    { service: "samskara-server-test" },
    {
      level: "debug",
      destination: {
        write: (line: string) => {
          lines.push(JSON.parse(line) as CapturedLine)
        },
      },
    },
  )
  return { log, lines, at: (level) => lines.filter((line) => line.level === LEVELS[level]) }
}
