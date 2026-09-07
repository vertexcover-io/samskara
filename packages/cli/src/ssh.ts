import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

const byAlias = new Map<string, Promise<string>>()

const isAlias = (host: string): boolean => /^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(host)

const ask = async (alias: string): Promise<string> => {
  const { stdout } = await execFileAsync("ssh", ["-G", alias], { timeout: 2000 })
  return stdout.match(/^hostname (.+)$/m)?.[1]?.trim() || alias
}

export const canonicalSshHost = (host: string): Promise<string> => {
  if (!isAlias(host)) return Promise.resolve(host)
  const hit = byAlias.get(host)
  if (hit) return hit
  const pending = ask(host)
  byAlias.set(host, pending)
  pending.catch(() => byAlias.delete(host))
  return pending
}
