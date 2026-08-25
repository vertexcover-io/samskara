import { createInterface } from "node:readline/promises"

export interface Writer {
  write(text: string): unknown
}

export type IoOptions = {
  readonly stdout?: Writer
  readonly stderr?: Writer
}

export type Io = {
  readonly stdout: Writer
  readonly stderr: Writer
}

export const resolveIo = (options: IoOptions = {}): Io => ({
  stdout: options.stdout ?? process.stdout,
  stderr: options.stderr ?? process.stderr,
})

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** Writes the failure and answers the exit code, so a catch reads `return reportError(...)`. */
export const reportError = (stderr: Writer, error: unknown, prefix?: string): number => {
  stderr.write(`${prefix === undefined ? "" : `${prefix}: `}${errorMessage(error)}\n`)
  return 1
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

export type Prompt = (question: string, fallback: string) => Promise<string>

/** An empty answer means "keep the default", so a whole setup can be walked through with Enter. */
export const askWithDefault: Prompt = async (question, fallback) => {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = (await rl.question(`${question} [${fallback}]: `)).trim()
    return answer === "" ? fallback : answer
  } finally {
    rl.close()
  }
}

/** Null when there is nobody to answer -- a hook, a CI run, a piped stdin -- so callers can skip asking. */
export const interactivePrompt = (): Prompt | null =>
  process.stdin.isTTY === true ? askWithDefault : null

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export const relativeTime = (iso: string, now: Date): string => {
  const elapsed = now.getTime() - new Date(iso).getTime()
  if (Number.isNaN(elapsed)) return iso
  if (elapsed < MINUTE) return "just now"
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m ago`
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h ago`
  if (elapsed < 30 * DAY) return `${Math.floor(elapsed / DAY)}d ago`
  return iso.slice(0, 10)
}
