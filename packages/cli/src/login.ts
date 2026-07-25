import { createInterface } from "node:readline/promises"
import { apiBase } from "./config.js"
import { storeToken } from "./config/credentials.js"

interface Writer {
  write(text: string): unknown
}

export type LoginOptions = {
  readonly code?: string
  readonly fetch?: typeof globalThis.fetch
  readonly promptForCode?: () => Promise<string>
  readonly stdout?: Writer
  readonly stderr?: Writer
}

const promptForCode = async (): Promise<string> => {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rl.question("Pairing code: ")
    return answer.trim()
  } finally {
    rl.close()
  }
}

const exchange = async (fetchImpl: typeof globalThis.fetch, code: string): Promise<string> => {
  const res = await fetchImpl(`${apiBase}/api/auth/cli-exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  })
  if (!res.ok) throw new Error(`pairing failed (${res.status})`)
  const body: unknown = await res.json()
  if (
    typeof body !== "object" ||
    body === null ||
    !("token" in body) ||
    typeof body.token !== "string"
  ) {
    throw new Error("pairing response missing token")
  }
  return body.token
}

export const login = async (options: LoginOptions): Promise<number> => {
  const stdout = options.stdout ?? process.stdout
  const stderr = options.stderr ?? process.stderr
  const readCode = options.promptForCode ?? promptForCode
  const code = options.code ?? (await readCode())
  if (!code) {
    stderr.write("a pairing code is required\n")
    return 1
  }

  try {
    const token = await exchange(options.fetch ?? globalThis.fetch, code)
    const path = await storeToken(token)
    stdout.write(`Logged in. Token stored at ${path}\n`)
    return 0
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}
