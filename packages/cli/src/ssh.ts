import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

const byAlias = new Map<string, Promise<string>>()

/**
 * A real host carries a dot, an alias does not. Gating on that keeps `ssh -G` away from
 * `Host github.com` entries -- GitHub's own SSH-over-443 workaround, and every corporate bastion --
 * whose `Hostname` would rewrite a correct host into the broken one. It doubles as the argument
 * guard: the host comes from the remote url, so `git@-F/tmp/evil:o/r` would otherwise reach ssh as
 * `-F configfile`.
 */
const isAlias = (host: string): boolean => /^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(host)

const ask = async (alias: string): Promise<string> => {
  const { stdout } = await execFileAsync("ssh", ["-G", alias], { timeout: 2000 })
  return stdout.match(/^hostname (.+)$/m)?.[1]?.trim() || alias
}

/**
 * `Host github-work` in `~/.ssh/config` is how a machine holds two GitHub accounts, and git stores
 * that alias verbatim in `remote.origin.url`. Left as written the repo never matches its org and
 * every link built from the host is dead. `ssh -G` is the only thing that knows what an alias
 * points at, and echoes an unknown name back, so a machine without the entry keeps the host git
 * recorded.
 *
 * **Rejects** when ssh could not be asked at all -- no binary, a non-zero exit, a `Match exec`
 * helper that outran the timeout. Answering with the alias here would look identical to a real
 * answer, and each caller wants something different from that: the project slug carries no host
 * and can keep the alias, while a repo identity is mostly host and must not be recorded wrong.
 *
 * Only an answer is cached, so a spawn that lost once to fork pressure does not pin the alias for
 * the life of the daemon.
 */
export const canonicalSshHost = (host: string): Promise<string> => {
  if (!isAlias(host)) return Promise.resolve(host)
  const hit = byAlias.get(host)
  if (hit) return hit
  const pending = ask(host)
  byAlias.set(host, pending)
  // The rejection belongs to the caller; this only drops the entry so the next call retries.
  pending.catch(() => byAlias.delete(host))
  return pending
}
