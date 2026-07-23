import { mkdir, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { createInterface } from "node:readline/promises"
import { apiBase } from "./config.js"

const tokenPath = (): string => join(homedir(), ".samskara", "token")

const promptForCode = async (): Promise<string> => {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rl.question("Pairing code: ")
    return answer.trim()
  } finally {
    rl.close()
  }
}

const exchange = async (apiBase: string, code: string): Promise<string> => {
  const res = await fetch(`${apiBase}/api/auth/cli-exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  })
  if (!res.ok) throw new Error(`pairing failed (${res.status})`)
  const body = (await res.json()) as { token?: unknown }
  if (typeof body.token !== "string") throw new Error("pairing response missing token")
  return body.token
}

const storeToken = async (token: string): Promise<string> => {
  const path = tokenPath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, token, { mode: 0o600 })
  return path
}

export const login = async (options: { code?: string }): Promise<void> => {
  const code = options.code ?? (await promptForCode())
  if (!code) {
    console.error("a pairing code is required")
    process.exitCode = 1
    return
  }

  try {
    const token = await exchange(apiBase, code)
    const path = await storeToken(token)
    console.log(`Logged in. Token stored at ${path}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
