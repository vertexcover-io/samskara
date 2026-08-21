import { createInterface } from "node:readline/promises"
import { type PublicUser, publicUserSchema } from "@samskara/core"
import { z } from "zod"
import { apiBase, webBase } from "./config.js"
import { storeToken } from "./config/credentials.js"
import { type Writer, errorMessage, resolveIo } from "./io.js"

export type LoginOptions = {
  readonly code?: string
  readonly promptForCode?: () => Promise<string>
  readonly stdout?: Writer
  readonly stderr?: Writer
}

export const pairingInstructions = (): string =>
  [
    `To get a pairing code, open ${webBase} and sign in, then choose "Pair the CLI"`,
    "from the account menu and select Generate code. A code does not expire, but it can",
    "only be used once.",
  ].join("\n")

const tokenResponseSchema = z.object({ token: z.string().min(1) })

const promptForCode = async (): Promise<string> => {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    process.stdout.write(`${pairingInstructions()}\n\n`)
    const answer = await rl.question("Pairing code: ")
    return answer.trim()
  } finally {
    rl.close()
  }
}

const redeemCode = async (code: string): Promise<string> => {
  const res = await fetch(`${apiBase}/api/auth/cli-exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  })
  if (res.status === 401) {
    throw new Error(
      "The server rejected this pairing code. It has already been used, or the server was restarted since it was generated, so please generate a new one.",
    )
  }
  if (!res.ok) {
    throw new Error(
      `Could not redeem the pairing code because the server responded with status ${res.status}.`,
    )
  }
  const parsed = tokenResponseSchema.safeParse(await res.json())
  if (!parsed.success) {
    throw new Error("The server accepted the pairing code but did not return a usable token.")
  }
  return parsed.data.token
}

export const verifyToken = async (token: string): Promise<PublicUser> => {
  const res = await fetch(`${apiBase}/api/auth/me`, {
    headers: { authorization: `Bearer ${token}` },
  })
  if (res.status === 401) {
    throw new Error("The server rejected the token received from pairing, so it was not saved.")
  }
  if (!res.ok) {
    throw new Error(
      `Could not confirm the token because the server responded with status ${res.status}. The token was not saved.`,
    )
  }
  const parsed = publicUserSchema.safeParse(await res.json())
  if (!parsed.success) {
    throw new Error(
      "The server returned an account record in a format this CLI does not recognize.",
    )
  }
  return parsed.data
}

/**
 * Whether the stored token still works, told apart from a server that is simply unreachable:
 * only a real rejection is worth nagging the user about.
 */
export type TokenCheck = "ok" | "rejected" | "unreachable"

export const checkToken = async (token: string): Promise<TokenCheck> => {
  try {
    const res = await fetch(`${apiBase}/api/auth/me`, {
      headers: { authorization: `Bearer ${token}` },
    })
    if (res.status === 401 || res.status === 403) return "rejected"
    return res.ok ? "ok" : "unreachable"
  } catch {
    return "unreachable"
  }
}

export const login = async (options: LoginOptions): Promise<number> => {
  const { stdout, stderr } = resolveIo(options)
  const readCode = options.promptForCode ?? promptForCode
  const code = options.code ?? (await readCode())
  if (!code) {
    stderr.write(`A pairing code is required to log in.\n${pairingInstructions()}\n`)
    return 1
  }

  try {
    const token = await redeemCode(code)
    const identity = await verifyToken(token)
    const path = await storeToken(token)
    stdout.write(`Logged in as ${identity.githubLogin}. The access token was saved to ${path}.\n`)
    return 0
  } catch (error) {
    stderr.write(`${errorMessage(error)}\n`)
    stderr.write(`${pairingInstructions()}\n`)
    return 1
  }
}
