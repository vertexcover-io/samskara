import { createReadStream, existsSync, watch as watchFs } from "node:fs"
import { stat } from "node:fs/promises"
import { createInterface } from "node:readline"
import { prettyFactory } from "pino-pretty"
import { currentLogPath, watchLogDir } from "../config/paths.js"
import { resolveIo, type Writer } from "../io.js"

export type LogsOptions = {
  readonly follow?: boolean
  readonly colorize?: boolean
  readonly stdout?: Writer
  readonly stderr?: Writer
}

type Formatter = (line: string) => string

const createFormatter = (colorize: boolean): Formatter => {
  const pretty = prettyFactory({
    colorize,
    translateTime: "SYS:HH:MM:ss",
    ignore: "pid,hostname",
  })
  return (line) => (line.trim() ? pretty(line) : "")
}

const printLogsFrom = async (
  path: string,
  start: number,
  stdout: Writer,
  format: Formatter,
): Promise<void> => {
  const reader = createInterface({
    input: createReadStream(path, { encoding: "utf8", start }),
    crlfDelay: Number.POSITIVE_INFINITY,
  })
  for await (const line of reader) stdout.write(format(line))
}

const sizeOf = (path: string): Promise<number> =>
  stat(path)
    .then((s) => s.size)
    .catch(() => 0)

export const logsCommand = async (options: LogsOptions = {}): Promise<number> => {
  const { stdout, stderr } = resolveIo(options)
  const path = currentLogPath()

  if (!existsSync(path)) {
    stderr.write(`no watcher logs yet at ${path}\n`)
    return 1
  }

  const format = createFormatter(options.colorize ?? true)
  await printLogsFrom(path, 0, stdout, format)
  if (!options.follow) return 0

  let position = await sizeOf(path)
  let draining = false
  const drain = async (): Promise<void> => {
    if (draining) return
    draining = true
    try {
      const size = await sizeOf(path)
      if (size < position) position = 0
      if (size > position) {
        await printLogsFrom(path, position, stdout, format)
        position = size
      }
    } finally {
      draining = false
    }
  }

  return new Promise<number>((_resolve, reject) => {
    const watcher = watchFs(watchLogDir(), () => {
      void drain().catch(reject)
    })
    watcher.on("error", reject)
  })
}
