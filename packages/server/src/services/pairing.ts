import { randomBytes } from "node:crypto"

export type PairingStore = {
  readonly mint: (userId: string) => string
  readonly redeem: (code: string) => string | null
}

type Entry = {
  readonly userId: string
  readonly expiresAt: number
}

const TTL_MS = 5 * 60 * 1000

export const createPairingStore = (now: () => number = () => Date.now()): PairingStore => {
  const codes = new Map<string, Entry>()

  const sweep = (at: number): void => {
    for (const [code, entry] of codes) {
      if (entry.expiresAt <= at) codes.delete(code)
    }
  }

  const mint = (userId: string): string => {
    const at = now()
    sweep(at)
    const code = randomBytes(16).toString("hex")
    codes.set(code, { userId, expiresAt: at + TTL_MS })
    return code
  }

  const redeem = (code: string): string | null => {
    const at = now()
    const entry = codes.get(code)
    codes.delete(code)
    if (!entry || entry.expiresAt <= at) return null
    return entry.userId
  }

  return { mint, redeem }
}
