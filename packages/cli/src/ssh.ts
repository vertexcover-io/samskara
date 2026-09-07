import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

const byAlias = new Map<string, Promise<string>>()

/**
 * A real host carries a dot; an ssh config alias, by the convention every multi-account setup
 * follows, does not. Gating on that keeps `ssh -G` away from a host that is already an address --
 * which matters because GitHub's own SSH-over-443 workaround, and every corporate bastion, is a
 * `Host github.com` entry pointing `Hostname` elsewhere. Resolving one of those would rewrite a
 * correct host into one the server refuses to match to an org and the web app cannot link to,
 * causing the very split this file exists to prevent.
 *
 * Doubling as the argument guard is deliberate: the host comes from `remote.origin.url`, so a
 * remote of `git@-F/tmp/evil:o/r` would otherwise reach ssh as the `-F configfile` option and have
 * `-G` evaluate any `Match exec` in a file the repo chose.
 */
const isAlias = (host: string): boolean => /^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(host)

const ask = async (alias: string): Promise<string> => {
  const { stdout } = await execFileAsync("ssh", ["-G", alias], { timeout: 2000 })
  return stdout.match(/^hostname (.+)$/m)?.[1]?.trim() || alias
}

/**
 * `Host github-work` in `~/.ssh/config` is the usual way to hold two GitHub accounts on one
 * machine, and git stores that alias verbatim in `remote.origin.url`. Left as written it is not
 * `github.com`, so the repo never matches its org, its clone is filed as a project of its own, and
 * every link built from the host points at a machine that does not exist.
 *
 * `ssh -G` is the only thing that knows what an alias resolves to. It echoes an unknown name
 * straight back, so a machine without the entry keeps the host git recorded; a missing ssh binary,
 * or a `Match exec` helper that blocks past the timeout, falls through to the same answer.
 *
 * A successful answer is cached for the process -- ssh config does not change under a running
 * daemon, and this sits on the path of every session the watcher sees. A failure is not: a spawn
 * that lost once to fork pressure or to ssh mid-upgrade must not pin the alias, and the split it
 * causes is exactly the bug being fixed.
 */
export const canonicalSshHost = (host: string): Promise<string> => {
  if (!isAlias(host)) return Promise.resolve(host)
  const hit = byAlias.get(host)
  if (hit) return hit
  const pending = ask(host).catch(() => {
    byAlias.delete(host)
    return host
  })
  byAlias.set(host, pending)
  return pending
}
