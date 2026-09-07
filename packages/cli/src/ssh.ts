import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

/** `certain` is false only when ssh was asked and could not answer, so the alias stands unresolved. */
export type SshHost = { readonly host: string; readonly certain: boolean }

const byAlias = new Map<string, Promise<SshHost>>()

/**
 * A real host carries a dot, an alias does not. Gating on that keeps `ssh -G` away from
 * `Host github.com` entries -- GitHub's own SSH-over-443 workaround, and every corporate bastion --
 * whose `Hostname` would rewrite a correct host into the broken one. It doubles as the argument
 * guard: the host comes from the remote url, so `git@-F/tmp/evil:o/r` would otherwise reach ssh as
 * `-F configfile`.
 */
const isAlias = (host: string): boolean => /^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(host)

const ask = async (alias: string): Promise<SshHost> => {
  const { stdout } = await execFileAsync("ssh", ["-G", alias], { timeout: 2000 })
  return { host: stdout.match(/^hostname (.+)$/m)?.[1]?.trim() || alias, certain: true }
}

/**
 * `Host github-work` in `~/.ssh/config` is how a machine holds two GitHub accounts, and git stores
 * that alias verbatim in `remote.origin.url`. Left as written the repo never matches its org and
 * every link built from the host is dead.
 *
 * `ssh -G` is the only thing that knows what an alias points at, and echoes an unknown name back,
 * so a machine without the entry keeps the host git recorded. Only an answer is cached, and a
 * failure is reported as uncertain: a spawn that lost once to fork pressure must not pin the alias
 * for the life of the daemon, here or in any cache built on this.
 */
export const canonicalSshHost = (host: string): Promise<SshHost> => {
  if (!isAlias(host)) return Promise.resolve({ host, certain: true })
  const hit = byAlias.get(host)
  if (hit) return hit
  const pending = ask(host).catch(() => {
    byAlias.delete(host)
    return { host, certain: false }
  })
  byAlias.set(host, pending)
  return pending
}
