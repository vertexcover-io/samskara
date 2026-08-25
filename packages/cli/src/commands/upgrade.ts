import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { z } from "zod"
import { type IoOptions, reportError, resolveIo } from "../io.js"
import { cliVersion } from "../version.js"

export const RELEASES_API = "https://api.github.com/repos/vertexcover-io/samskara/releases/latest"

const ReleaseSchema = z.object({
  tag_name: z.string(),
  assets: z.array(z.object({ name: z.string(), browser_download_url: z.string() })),
})

const SEGMENTS = /^v?(\d+)\.(\d+)\.(\d+)(-.+)?$/

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

export type UpgradeOptions = { readonly check?: boolean }

export type UpgradeDeps = IoOptions & {
  readonly fetch?: typeof globalThis.fetch
  readonly install?: (tarballUrl: string) => Promise<void>
  readonly current?: string
}

/** The release artifact is an npm tarball, not a standalone binary, so the upgrade is the same
 * `npm i -g TARBALL` the README documents -- npm unpacks it over the existing global install and
 * fetches the dependencies the bundled copy of core needs. */
const npmInstall = async (tarballUrl: string): Promise<void> => {
  await promisify(execFile)("npm", ["install", "--global", tarballUrl])
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

  try {
    const latest = await latestRelease(deps.fetch ?? globalThis.fetch)

    if (!isNewer(latest.version, current)) {
      stdout.write(`samskara ${current} is the latest release.\n`)
      return 0
    }

    if (options.check === true) {
      stdout.write(
        `samskara ${latest.version} is available (you have ${current}).\nRun \`samskara upgrade\` to install it.\n`,
      )
      return 0
    }

    stdout.write(`Upgrading samskara ${current} to ${latest.version}...\n`)
    await install(latest.tarball)
    stdout.write(
      `Installed samskara ${latest.version}. Run \`samskara restart\` so the watcher picks it up.\n`,
    )
    return 0
  } catch (error) {
    return reportError(stderr, error)
  }
}
