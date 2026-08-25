import { randomBytes } from "node:crypto"

export type PairingStore = {
  readonly mint: (userId: string) => string
  readonly redeem: (code: string) => string | null
}

export const createPairingStore = (): PairingStore => {
  const codes = new Map<string, string>()
  const latest = new Map<string, string>()

  // Codes no longer expire, so nothing else would ever remove one. Holding at most a code per
  // user bounds the map by the user count instead of by how often anyone presses Generate, and
  // matches what generating a new code already means: the old one is not the one to paste.
  const mint = (userId: string): string => {
    const previous = latest.get(userId)
    if (previous !== undefined) codes.delete(previous)

    const code = randomBytes(16).toString("hex")
    codes.set(code, userId)
    latest.set(userId, code)
    return code
  }

  const redeem = (code: string): string | null => {
    const userId = codes.get(code)
    if (userId === undefined) return null
    codes.delete(code)
    latest.delete(userId)
    return userId
  }

  return { mint, redeem }
}
