import { createReadStream, existsSync, watch as watchFs } from "node:fs"
import { open, stat } from "node:fs/promises"
import { createInterface } from "node:readline"
import { prettyFactory } from "pino-pretty"
import { currentLogPath, watchLogDir } from "../config/paths.js"
import { warnOnServerChange } from "../config/server-scope.js"
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

/** Complete lines from `start` to EOF, and the byte offset just past the last newline read. */
const readLinesFrom = async (
  path: string,
  start: number,
): Promise<{ readonly lines: ReadonlyArray<string>; readonly end: number }> => {
  const handle = await open(path, "r")
  try {
    const { size } = await handle.stat()
    const buffer = Buffer.alloc(Math.max(size - start, 0))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start)
    const complete = buffer.subarray(0, buffer.subarray(0, bytesRead).lastIndexOf(0x0a) + 1)
    return {
      lines: complete.toString("utf8").split("\n").slice(0, -1),
      end: start + complete.length,
    }
  } finally {
    await handle.close()
  }
}

// The watcher is attached before the first read and the position only ever advances by bytes
// actually read, so a line written between the dump and the first event is never skipped.
const follow = (path: string, stdout: Writer, format: Formatter): Promise<number> => {
  let position = 0
  let drained: Promise<void> = Promise.resolve()
  const drain = async (): Promise<void> => {
    if ((await sizeOf(path)) < position) position = 0
    const { lines, end } = await readLinesFrom(path, position)
    for (const line of lines) stdout.write(format(line))
    position = end
  }
  return new Promise<number>((_resolve, reject) => {
    const next = () => {
      drained = drained.then(drain)
      drained.catch(reject)
    }
    const watcher = watchFs(watchLogDir(), next)
    watcher.on("error", reject)
    next()
  })
}

export const logsCommand = async (options: LogsOptions = {}): Promise<number> => {
  const { stdout, stderr } = resolveIo(options)
  await warnOnServerChange(stderr).catch(() => {})
  const path = currentLogPath()

  if (!existsSync(path)) {
    stderr.write(`no watcher logs yet at ${path}\n`)
    return 1
  }

  const format = createFormatter(options.colorize ?? true)
  if (options.follow) return follow(path, stdout, format)
  await printLogsFrom(path, 0, stdout, format)
  return 0
}
