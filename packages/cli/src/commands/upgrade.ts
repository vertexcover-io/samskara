import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { z } from "zod"
import { startWatcherDaemon, stopWatcherDaemon, watcherPid } from "../config/daemon.js"
import { errorMessage, type IoOptions, reportError, resolveIo, type Writer } from "../io.js"
import { cliVersion } from "../version.js"

export const RELEASES_API = "https://api.github.com/repos/vertexcover-io/samskara/releases/latest"

const ReleaseSchema = z.object({
  tag_name: z.string(),
  assets: z.array(z.object({ name: z.string(), browser_download_url: z.string() })),
})

const SEGMENTS = /^v?(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?(?:\+.+)?$/

type Parsed = { readonly segments: readonly number[]; readonly prerelease: boolean }

const parseVersion = (version: string): Parsed | null => {
  const match = SEGMENTS.exec(version.trim())
  if (!match) return null
  return {
    segments: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] !== undefined,
  }
}

/** A prerelease sorts below the release with the same numbers, so `1.2.3` upgrades `1.2.3-rc.1`. */
export const isNewer = (candidate: string, current: string): boolean => {
  const a = parseVersion(candidate)
  const b = parseVersion(current)
  if (!a || !b) return false
  for (const [index, value] of a.segments.entries()) {
    const other = b.segments[index] ?? 0
    if (value !== other) return value > other
  }
  return b.prerelease && !a.prerelease
}

export type UpgradeOptions = { readonly check?: boolean; readonly json?: boolean }

export type WatcherRestart = { readonly restarted: boolean; readonly pid: number | null }

export type UpgradeDeps = IoOptions & {
  readonly fetch?: typeof globalThis.fetch
  readonly install?: (tarballUrl: string) => Promise<void>
  readonly restartWatcher?: () => Promise<WatcherRestart>
  readonly current?: string
}

/** The release artifact is an npm tarball, not a standalone binary, so the upgrade is the same
 * `npm i -g TARBALL` the README documents -- npm unpacks it over the existing global install and
 * fetches the dependencies the bundled copy of core needs. */
const npmInstall = async (tarballUrl: string): Promise<void> => {
  await promisify(execFile)("npm", ["install", "--global", tarballUrl])
}

/** The new build only takes effect once the daemon is respawned from it, and a watcher that was
 * not running is left alone -- upgrading is not a reason to start capturing. */
const restartWatcherDaemon = async (): Promise<WatcherRestart> => {
  if (watcherPid() === null) return { restarted: false, pid: null }
  await stopWatcherDaemon()
  return { restarted: true, pid: await startWatcherDaemon() }
}

type RestartOutcome = WatcherRestart & { readonly error?: string }

/** A restart that fails does not undo a successful install, so it is reported, not thrown. */
const tryRestart = async (restart: () => Promise<WatcherRestart>): Promise<RestartOutcome> => {
  try {
    return await restart()
  } catch (error) {
    return { restarted: false, pid: null, error: errorMessage(error) }
  }
}

const writeJson = (writer: Writer, payload: unknown): void => {
  writer.write(`${JSON.stringify(payload, null, 2)}\n`)
}

const restartLine = (outcome: RestartOutcome): string => {
  if (outcome.error !== undefined) {
    return `Could not restart the capture watcher (${outcome.error}). Run \`samskara restart\` yourself.\n`
  }
  if (!outcome.restarted) return "The capture watcher was not running, so nothing to restart.\n"
  return `Restarted the capture watcher (process ${outcome.pid}).\n`
}

const latestRelease = async (
  fetchImpl: typeof globalThis.fetch,
): Promise<{ version: string; tarball: string }> => {
  const response = await fetchImpl(RELEASES_API, {
    headers: { accept: "application/vnd.github+json", "user-agent": "samskara-cli" },
  })
  if (!response.ok) {
    throw new Error(`GitHub answered ${response.status} for the latest release`)
  }
  const release = ReleaseSchema.parse(await response.json())
  const version = release.tag_name.replace(/^v/, "")
  const asset = release.assets.find((candidate) => candidate.name.endsWith(".tgz"))
  if (!asset) {
    throw new Error(`release ${release.tag_name} has no .tgz tarball attached`)
  }
  return { version, tarball: asset.browser_download_url }
}

export const upgradeCommand = async (
  options: UpgradeOptions = {},
  deps: UpgradeDeps = {},
): Promise<number> => {
  const { stdout, stderr } = resolveIo(deps)
  const current = deps.current ?? cliVersion
  const install = deps.install ?? npmInstall
  const restart = deps.restartWatcher ?? restartWatcherDaemon
  const json = options.json === true

  try {
    const latest = await latestRelease(deps.fetch ?? globalThis.fetch)
    const versions = { current, latest: latest.version }

    if (!isNewer(latest.version, current)) {
      if (json) writeJson(stdout, { status: "current", ...versions })
      else stdout.write(`samskara ${current} is the latest release.\n`)
      return 0
    }

    if (options.check === true) {
      if (json) writeJson(stdout, { status: "available", ...versions, tarball: latest.tarball })
      else
        stdout.write(
          `samskara ${latest.version} is available (you have ${current}).\nRun \`samskara upgrade\` to install it.\n`,
        )
      return 0
    }

    if (!json) stdout.write(`Upgrading samskara ${current} to ${latest.version}...\n`)
    await install(latest.tarball)
    const watcher = await tryRestart(restart)

    if (json) {
      writeJson(stdout, { status: "upgraded", ...versions, watcher })
      return 0
    }
    stdout.write(`Installed samskara ${latest.version}.\n`)
    ;(watcher.error === undefined ? stdout : stderr).write(restartLine(watcher))
    return 0
  } catch (error) {
    if (json) {
      writeJson(stderr, { status: "error", message: errorMessage(error) })
      return 1
    }
    return reportError(stderr, error)
  }
}
