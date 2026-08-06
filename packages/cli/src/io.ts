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
